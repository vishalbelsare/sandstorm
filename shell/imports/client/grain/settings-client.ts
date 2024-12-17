
import { TAPi18n } from "/imports/tapi18n";
import { Template } from "meteor/templating";
import { Match, check } from "meteor/check";
import { globalDb } from "/imports/db-deprecated";
import { GrainView } from "/imports/client/grain/grainview";

Template.sandstormGrainSettingsPage.onCreated(function() {
  const instance = Template.instance();
  instance.subscribe("scheduledJobs");
  instance.autorun(() => {
    check(Template.currentData(), { grain: GrainView });
  });
})

Template.sandstormGrainSettingsPage.helpers({
  scheduledJobs() {
    const data = Template.currentData();
    return globalDb.collections.scheduledJobs.find({grainId: data.grain.grainId()});
  }
});

Template.sandstormGrainSettingsPage.events({
  "click .grain-settings-return-to-grain-button": function(_event: unknown) {
    Template.currentData().grain.setShowSettings(false);
  },
})

Template.sandstormGrainSettingsScheduledJob.onCreated(function () {
  Template.instance().autorun(() => {
    check(Template.currentData(), {
      job: Match.ObjectIncluding({
        name: { defaultText: String },
        period: String,
        nextPeriodStart: Date,
        created: Date,
      }),
    });
  });
});


Template.sandstormGrainSettingsScheduledJob.helpers({
  period() {
    return TAPi18n.__(
      "grains.settings.scheduledTasks.periodNames." +
      Template.currentData().job.period
    );
  },

  description() {
    return Template.currentData().job.name.defaultText;
  },

  next() {
    return Template.currentData().job.nextPeriodStart;
  },

  created() {
    return Template.currentData().job.created;
  },
})
