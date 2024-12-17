// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2017 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Meteor } from "meteor/meteor";

import { waitPromise } from "/imports/server/async-helpers";
import { fetchApiToken } from "/imports/server/persistent";
import Capnp from "/imports/server/capnp";
import { SandstormDb } from "/imports/sandstorm-db/db";
import { globalDb } from "/imports/db-deprecated";
import { filterCallbacks, subscriptionCallbacks } from "/imports/collection-utils";

const ScheduledJob = Capnp.importSystem("sandstorm/grain.capnp").ScheduledJob;
const SystemPersistent = Capnp.importSystem("sandstorm/supervisor.capnp").SystemPersistent;

const MINIMUM_SCHEDULING_SLACK_NANO = Capnp.importSystem("sandstorm/grain.capnp").minimumSchedulingSlack;
const MINIMUM_SCHEDULING_SLACK_MILLIS = MINIMUM_SCHEDULING_SLACK_NANO / 1e6;

export const scheduleOneShot = (db, grainId, name, callback, when, slack) => {
  callback.castAs(SystemPersistent).save({ frontend: null }).then((result) => {
    db.addOneShotScheduledJob(
      grainId,
      name,
      result.sturdyRef.toString("utf8"),
      when,
      slack,
    );
  })
}

export const schedulePeriodic = (db, grainId, name, callback, period) => {
  callback.castAs(SystemPersistent).save({ frontend: null }).then((result) => {
    db.addPeriodicScheduledJob(
      grainId,
      name,
      result.sturdyRef.toString("utf8"),
      period
    );
  });
}

const KEEP_ALIVE_INTERVAL_MILLIS = 60 * 1000;
const MAX_DISCONNECTED_RETRIES = 5;

export const runDueJobs = (nowMillis) => {
  const db = globalDb;
  const staleKeepAlive = new Date(nowMillis - 3 * KEEP_ALIVE_INTERVAL_MILLIS);
  const jobs = db.getReadyScheduledJobs(nowMillis, staleKeepAlive);

  const promises = [];

  jobs.forEach((job) => {
    if (job.lastKeepAlive) {
      if (job.retries && job.retries >= MAX_DISCONNECTED_RETRIES) {
        db.recordScheduledJobRan(job, {
          finished: job.lastKeepAlive,
          type: "disconnected",
          message: "MAX_DISCONNECTED_RETRIES exceeded",
        });
      } else {
        db.scheduledJobIncrementRetries(job._id);
      }
    }

    const token = fetchApiToken(db, job.callback);
    if (!token) {
      throw new Error("could not find ApiToken for callback", job.callback);
    }

    let intervalHandle;

    promises.push(Promise.resolve().then(() => {
      let callback = restoreInternal(db, job.callback, { frontend: null }, [], token).cap;
      callback = callback.castAs(ScheduledJob.Callback);

      intervalHandle = Meteor.setInterval(() => {
        globalBackend.useGrain(job.grainId, (supervisor) => {
          return supervisor.keepAlive();
        });
        db.updateScheduledJobKeepAlive(job._id);
      }, KEEP_ALIVE_INTERVAL_MILLIS);

      return callback.run();
    }).then(({cancelFutureRuns}) => {
      if(cancelFutureRuns || job.period === undefined) {
        // Either the job explicitly told us to cancel it (cancelFutureRuns),
        // or it was one-shot job (period is undefined). Remove the job:
        db.deleteScheduledJob(job._id);
        return;
      }
      db.recordScheduledJobRan(job);
    }, (e) => {
      if (e.kjType === "disconnected") {
        db.scheduledJobIncrementRetries(job._id);
      } else {
        const type = e.kjType || "failed";
        db.recordScheduledJobRan(job, {
          finished: new Date(),
          type,
          message: e.toString().slice(0, 200), // cap length to prevent grain from spamming the db
        });
      }
    }).catch((e) => {
      console.error("error while scheduling job", e);
    }).then(() => {
      if (intervalHandle) {
        Meteor.clearInterval(intervalHandle);
      }
    }));
  });

  waitPromise(Promise.all(promises));
}

SandstormDb.periodicCleanup(MINIMUM_SCHEDULING_SLACK_MILLIS, () => runDueJobs(Date.now()));

Meteor.publish("scheduledJobs", function() {
  // Returns info about all jobs for grains owned by the current user.
  if(!this.userId) {
    return [];
  }
  const db = globalDb;

  db.collections.scheduledJobs.find({}, {
      _id: 1,
      grainId: 1,
      name: 1,
      created: 1,
      period: 1,
      nextPeriodStart: 1,
      previousError: 1,
  }).observe(filterCallbacks(subscriptionCallbacks("scheduledJobs", this), ({grainId}) => {
    const owner = db.collections.grains.findOne({_id: grainId}, {userId: 1}).userId;
    return db.isAdmin() || owner === this.userId();
  }));
  this.ready();
});
