/*
 * Garmin account-export importer for the fitness tracker.
 *
 * Browser usage after wiring:
 *   <script src="./garmin-importer.js"></script>
 *   const result = await GarminImporter.importFiles(fileInput.files);
 *
 * Node / validation usage:
 *   const GarminImporter = require("./garmin-importer.js");
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GarminImporter = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SOURCE_PROVIDER = "Garmin Connect";
  const PARSER_VERSION = "1.0.0";

  const FILE_KINDS = {
    DAILY_SUMMARY: "daily-summary",
    SLEEP: "sleep",
    ACTIVITY: "activity",
    TRAINING_READINESS: "training-readiness",
    HEALTH_STATUS: "health-status",
    HYDRATION: "hydration",
    UNSUPPORTED: "unsupported"
  };

  const FILE_CLASSIFIERS = [
    {
      kind: FILE_KINDS.DAILY_SUMMARY,
      label: "DI-Connect-Aggregator UDS daily summary",
      sourceType: "DI-Connect-Aggregator/UDSFile",
      pattern: /(?:^|[\\/])DI-Connect-Aggregator[\\/](?:.*[\\/])?UDSFile_[^\\/]+\.json$/i
    },
    {
      kind: FILE_KINDS.SLEEP,
      label: "DI-Connect-Wellness sleep data",
      sourceType: "DI-Connect-Wellness/sleepData",
      pattern: /(?:^|[\\/])DI-Connect-Wellness[\\/](?:.*[\\/])?sleepData\.json$/i
    },
    {
      kind: FILE_KINDS.ACTIVITY,
      label: "DI-Connect-Fitness summarized activities",
      sourceType: "DI-Connect-Fitness/summarizedActivities",
      pattern: /(?:^|[\\/])DI-Connect-Fitness[\\/](?:.*[\\/])?summarizedActivities\.json$/i
    },
    {
      kind: FILE_KINDS.TRAINING_READINESS,
      label: "Metrics training readiness",
      sourceType: "Metrics/TrainingReadinessDTO",
      pattern: /(?:^|[\\/])Metrics[\\/](?:.*[\\/])?TrainingReadinessDTO_[^\\/]+\.json$/i
    },
    {
      kind: FILE_KINDS.HEALTH_STATUS,
      label: "Wellness health status",
      sourceType: "Wellness/healthStatusData",
      pattern: /(?:^|[\\/])Wellness[\\/](?:.*[\\/])?healthStatusData\.json$/i
    },
    {
      kind: FILE_KINDS.HYDRATION,
      label: "Hydration log",
      sourceType: "HydrationLogFile",
      pattern: /(?:^|[\\/])HydrationLogFile_[^\\/]+\.json$/i
    }
  ];

  const TRACKER_FIELD_PRIORITIES = {
    "daily-summary.steps": 90,
    "daily-summary.sleepHours": 55,
    "daily-summary.waterLiters": 55,
    "sleep.sleepHours": 95,
    "hydration.waterLiters": 95,
    "health-status.weight": 90,
    "health-status.restingHeartRate": 85,
    "health-status.bodyBattery": 85,
    "health-status.stressLevel": 85,
    "health-status.respirationRate": 80,
    "health-status.sleepScore": 80,
    "training-readiness.trainingReadiness": 90,
    "training-readiness.sleepScore": 82,
    "training-readiness.recoveryHours": 80,
    "training-readiness.hrvStatus": 80
  };

  function importFiles(fileLikeList, options) {
    const descriptors = Array.isArray(fileLikeList) ? fileLikeList : Array.from(fileLikeList || []);
    const tasks = descriptors.map(function (item, index) {
      return toFileDescriptor(item, index);
    });

    return Promise.all(tasks).then(function (resolvedDescriptors) {
      return normalizeResolvedFiles(resolvedDescriptors, options);
    });
  }

  function normalizeFiles(fileDescriptors, options) {
    const descriptors = Array.isArray(fileDescriptors) ? fileDescriptors : Array.from(fileDescriptors || []);
    const resolved = descriptors.map(function (item, index) {
      return normalizeDescriptorShape(item, index);
    });
    return normalizeResolvedFiles(resolved, options);
  }

  function normalizeFile(fileDescriptor, options) {
    return normalizeFiles([fileDescriptor], options);
  }

  function normalizeResolvedFiles(descriptors, options) {
    const result = {
      provider: SOURCE_PROVIDER,
      parserVersion: PARSER_VERSION,
      createdAt: new Date().toISOString(),
      files: [],
      records: [],
      trackerEntryDrafts: [],
      warnings: [],
      skippedFiles: [],
      stats: {
        scannedFileCount: 0,
        matchedFileCount: 0,
        skippedFileCount: 0,
        importedRecordCount: 0,
        deduplicatedRecordCount: 0,
        warningCount: 0
      }
    };

    const recordMap = new Map();

    let rawRecordCount = 0;

    descriptors.forEach(function (descriptor, index) {
      const fileSummary = normalizeSingleResolvedFile(descriptor, index, options);
      result.stats.scannedFileCount += 1;
      result.files.push(fileSummary.file);
      rawRecordCount += fileSummary.file.recordCount || 0;

      if (fileSummary.file.kind === FILE_KINDS.UNSUPPORTED || fileSummary.file.parseError) {
        result.stats.skippedFileCount += 1;
        result.skippedFiles.push(fileSummary.file);
      } else {
        result.stats.matchedFileCount += 1;
      }

      appendAll(result.warnings, fileSummary.warnings);

      fileSummary.records.forEach(function (record) {
        upsertRecord(recordMap, record);
      });
    });

    result.records = Array.from(recordMap.values()).sort(compareRecords);
    result.trackerEntryDrafts = buildTrackerEntryDrafts(result.records);
    result.stats.importedRecordCount = result.records.length;
    result.stats.deduplicatedRecordCount = Math.max(0, rawRecordCount - result.records.length);
    result.warnings = dedupeStrings(result.warnings);
    result.stats.warningCount = result.warnings.length;

    return result;
  }

  function normalizeSingleResolvedFile(descriptor, index) {
    const normalized = normalizeDescriptorShape(descriptor, index);
    const classification = classifyFile(normalized.path || normalized.name);
    const fileWarnings = [];

    if (classification.kind === FILE_KINDS.UNSUPPORTED) {
      return {
        file: {
          name: normalized.name,
          path: normalized.path,
          kind: classification.kind,
          label: classification.label,
          matched: false
        },
        records: [],
        warnings: []
      };
    }

    if (!normalized.hasInlineJson && typeof normalized.text !== "string") {
      const missingText = "File content was not provided as text/json and could not be read.";
      return {
        file: {
          name: normalized.name,
          path: normalized.path,
          kind: classification.kind,
          label: classification.label,
          matched: true,
          parseError: missingText
        },
        records: [],
        warnings: [missingText]
      };
    }

    let payload;
    if (normalized.hasInlineJson) {
      payload = normalized.json;
    } else {
      try {
        payload = JSON.parse(normalized.text);
      } catch (error) {
        const parseError = "Invalid JSON: " + (error && error.message ? error.message : "Unknown parse error.");
        return {
          file: {
            name: normalized.name,
            path: normalized.path,
            kind: classification.kind,
            label: classification.label,
            matched: true,
            parseError: parseError
          },
          records: [],
          warnings: [parseError]
        };
      }
    }

    const context = {
      fileName: normalized.name,
      filePath: normalized.path,
      classification: classification,
      fileDateHint: extractDateFromText(normalized.path || normalized.name),
      fileWarnings: fileWarnings
    };

    let records = [];
    if (classification.kind === FILE_KINDS.DAILY_SUMMARY) {
      records = normalizeDailySummaryPayload(payload, context);
    } else if (classification.kind === FILE_KINDS.SLEEP) {
      records = normalizeSleepPayload(payload, context);
    } else if (classification.kind === FILE_KINDS.ACTIVITY) {
      records = normalizeActivityPayload(payload, context);
    } else if (classification.kind === FILE_KINDS.TRAINING_READINESS) {
      records = normalizeTrainingReadinessPayload(payload, context);
    } else if (classification.kind === FILE_KINDS.HEALTH_STATUS) {
      records = normalizeHealthStatusPayload(payload, context);
    } else if (classification.kind === FILE_KINDS.HYDRATION) {
      records = normalizeHydrationPayload(payload, context);
    }
    return {
      file: {
        name: normalized.name,
        path: normalized.path,
        kind: classification.kind,
        label: classification.label,
        sourceType: classification.sourceType,
        matched: true,
        recordCount: records.length,
        warnings: dedupeStrings(fileWarnings)
      },
      records: records,
      warnings: dedupeStrings(fileWarnings.concat(flattenRecordWarnings(records)))
    };
  }

  function normalizeDailySummaryPayload(payload, context) {
    const items = getCollection(payload, [
      "dailySummaries",
      "records",
      "items",
      "data"
    ]);

    return items.map(function (item, index) {
      return normalizeDailySummaryRecord(item, context, index);
    }).filter(Boolean);
  }

  function normalizeSleepPayload(payload, context) {
    const nested = getByPath(payload, "sleepData");
    const items = getCollection(nested !== undefined ? nested : payload, [
      "dailySleepDTOs",
      "dailySleepDTO",
      "sleepSummaries",
      "records",
      "items",
      "data"
    ]);

    return items.map(function (item, index) {
      return normalizeSleepRecord(item, context, index);
    }).filter(Boolean);
  }

  function normalizeActivityPayload(payload, context) {
    const items = getCollection(payload, [
      "summarizedActivitiesExport",
      "activities",
      "records",
      "items",
      "data"
    ]);

    return items.map(function (item, index) {
      return normalizeActivityRecord(item, context, index);
    }).filter(Boolean);
  }

  function normalizeTrainingReadinessPayload(payload, context) {
    const items = getCollection(payload, [
      "trainingReadinessDTO",
      "trainingReadiness",
      "records",
      "items",
      "data"
    ]);

    return items.map(function (item, index) {
      return normalizeTrainingReadinessRecord(item, context, index);
    }).filter(Boolean);
  }

  function normalizeHealthStatusPayload(payload, context) {
    const items = getCollection(payload, [
      "healthStatusData",
      "healthStatus",
      "wellnessData",
      "records",
      "items",
      "data"
    ]);

    return items.map(function (item, index) {
      return normalizeHealthStatusRecord(item, context, index);
    }).filter(Boolean);
  }

  function normalizeHydrationPayload(payload, context) {
    const items = getCollection(payload, [
      "hydrationLogs",
      "hydrationLog",
      "records",
      "items",
      "data"
    ]);

    return items.map(function (item, index) {
      return normalizeHydrationRecord(item, context, index);
    }).filter(Boolean);
  }

  function normalizeDailySummaryRecord(item, context, index) {
    if (!isPlainObject(item)) {
      context.fileWarnings.push("Skipped non-object UDS daily summary record.");
      return null;
    }

    const dateInfo = resolveDateValue(firstDefined(
      getByPath(item, "calendarDate.date"),
      getByPath(item, "calendarDate"),
      getByPath(item, "summaryDate"),
      getByPath(item, "date"),
      context.fileDateHint
    ), "daily summary date");

    if (!dateInfo.dateKey) {
      appendAll(context.fileWarnings, dateInfo.warnings);
      context.fileWarnings.push("Skipped UDS daily summary record with an invalid or missing date.");
      return null;
    }

    const hydration = normalizeHydrationAmount(
      firstDefined(
        getByPath(item, "hydrationConsumedMl"),
        getByPath(item, "hydration"),
        getByPath(item, "hydrationData"),
        getByPath(item, "hydrationSummary")
      ),
      firstDefined(
        getByPath(item, "hydrationUnit"),
        getByPath(item, "hydration.unit"),
        getByPath(item, "hydrationData.unit")
      ),
      "daily summary hydration"
    );

    const actualSleepSeconds = pickFiniteNumber(item, [
      "sleepData.actualSleepDurationInSeconds",
      "sleep.actualSleepDurationInSeconds",
      "sleep.actualSleepDuration",
      "sleep.durationInSeconds",
      "sleepDurationInSeconds"
    ]);

    const record = createBaseRecord(FILE_KINDS.DAILY_SUMMARY, context, index, dateInfo.dateKey);

    record.sourceTimestamp = resolveSourceTimestamp(item, [
      "lastUpdatedTimestamp",
      "lastUpdateTimestamp",
      "lastUpdatedDate",
      "lastSyncTimestamp",
      "calendarDate.date"
    ], dateInfo);
    record.upsertKey = "garmin:daily-summary:" + dateInfo.dateKey;
    record.values = pruneEmpty({
      steps: pickFiniteNumber(item, ["totalSteps", "steps", "dailyStepCount", "stepCount"]),
      distanceMeters: pickFiniteNumber(item, ["distance", "distanceInMeters", "totalDistanceInMeters"]),
      activeTimeSeconds: pickFiniteNumber(item, ["activeTimeInSeconds", "activeSeconds"]),
      intensityMinutes: normalizeMinutes(
        firstDefined(
          getByPath(item, "intensityMinutes"),
          getByPath(item, "intensityDurationInSeconds"),
          getByPath(item, "moderateIntensityDurationInSeconds")
        )
      ),
      sleepSeconds: actualSleepSeconds,
      waterMilliliters: hydration.value,
      restingHeartRate: pickFiniteNumber(item, ["restingHeartRate", "restingHr", "restHeartRate"]),
      minHeartRate: pickFiniteNumber(item, ["minHeartRate", "minimumHeartRate"]),
      maxHeartRate: pickFiniteNumber(item, ["maxHeartRate", "maximumHeartRate"]),
      averageStressLevel: extractStressLevel(item),
      bodyBattery: pickFiniteNumber(item, [
        "bodyBattery.mostRecentValue",
        "bodyBattery.value",
        "bodyBattery.maxValue",
        "bodyBattery"
      ])
    });
    record.units = pruneEmpty({
      steps: "count",
      distanceMeters: "meters",
      activeTimeSeconds: "seconds",
      intensityMinutes: "minutes",
      sleepSeconds: "seconds",
      waterMilliliters: hydration.value !== null ? "milliliters" : null,
      restingHeartRate: record.values.restingHeartRate !== undefined ? "bpm" : null,
      minHeartRate: record.values.minHeartRate !== undefined ? "bpm" : null,
      maxHeartRate: record.values.maxHeartRate !== undefined ? "bpm" : null,
      averageStressLevel: record.values.averageStressLevel !== undefined ? "score" : null,
      bodyBattery: record.values.bodyBattery !== undefined ? "score" : null
    });
    record.displayOnly = pruneEmpty({
      energy: pruneEmpty({
        totalKilocalories: pickFiniteNumber(item, ["totalCalories", "totalKilocalories"]),
        activeKilocalories: pickFiniteNumber(item, ["activeCalories", "activeKilocalories"]),
        note: "Display only. Do not ingest Garmin calorie totals as tracker daily burn."
      })
    });
    record.warnings = dedupeStrings(
      []
        .concat(dateInfo.warnings)
        .concat(hydration.warnings)
    );

    return record;
  }

  function normalizeSleepRecord(item, context, index) {
    if (!isPlainObject(item)) {
      context.fileWarnings.push("Skipped non-object sleep record.");
      return null;
    }

    const startInfo = resolveDateValue(firstDefined(
      getByPath(item, "sleepStartTimestampLocal"),
      getByPath(item, "sleepStartTimestampGMT"),
      getByPath(item, "startTimestampLocal"),
      getByPath(item, "startTimestampGMT"),
      getByPath(item, "startTimeLocal"),
      getByPath(item, "startTimeGMT"),
      getByPath(item, "startTime"),
      getByPath(item, "startTimestamp")
    ), "sleep start timestamp");
    const endInfo = resolveDateValue(firstDefined(
      getByPath(item, "sleepEndTimestampLocal"),
      getByPath(item, "sleepEndTimestampGMT"),
      getByPath(item, "endTimestampLocal"),
      getByPath(item, "endTimestampGMT"),
      getByPath(item, "endTimeLocal"),
      getByPath(item, "endTimeGMT"),
      getByPath(item, "endTime"),
      getByPath(item, "endTimestamp")
    ), "sleep end timestamp");
    const dateInfo = resolveDateValue(firstDefined(
      getByPath(item, "calendarDate.date"),
      getByPath(item, "calendarDate"),
      getByPath(item, "sleepDate"),
      endInfo.dateKey,
      startInfo.dateKey,
      context.fileDateHint
    ), "sleep date");

    if (!dateInfo.dateKey) {
      appendAll(context.fileWarnings, dateInfo.warnings);
      appendAll(context.fileWarnings, startInfo.warnings);
      appendAll(context.fileWarnings, endInfo.warnings);
      context.fileWarnings.push("Skipped sleep record with an invalid or missing date.");
      return null;
    }

    const sleepLevels = normalizeSleepLevels(firstDefined(
      getByPath(item, "sleepLevelsMap"),
      getByPath(item, "sleepLevels"),
      getByPath(item, "sleep.sleepLevelsMap")
    ));

    const actualSleepSeconds = pickFiniteNumber(item, [
      "actualSleepDurationInSeconds",
      "actualSleepDuration",
      "sleepTimeSeconds",
      "sleepTimeInSeconds"
    ]);
    const awakeSeconds = pickFiniteNumber(item, [
      "awakeDurationInSeconds",
      "awakeTimeInSeconds"
    ]);

    const record = createBaseRecord(FILE_KINDS.SLEEP, context, index, dateInfo.dateKey);
    record.sourceTimestamp = firstDefined(endInfo.sourceTimestamp, startInfo.sourceTimestamp, dateInfo.sourceTimestamp);
    record.upsertKey = [
      "garmin:sleep",
      dateInfo.dateKey,
      firstDefined(
        getByPath(item, "sleepSummaryId"),
        getByPath(item, "sleepId"),
        getByPath(item, "uuid"),
        sanitizeKeyPart(startInfo.sourceTimestamp),
        sanitizeKeyPart(endInfo.sourceTimestamp),
        String(index)
      )
    ].join(":");
    record.values = pruneEmpty({
      sleepSeconds: actualSleepSeconds,
      awakeSeconds: awakeSeconds,
      deepSleepSeconds: sleepLevels.deepSleepSeconds,
      lightSleepSeconds: sleepLevels.lightSleepSeconds,
      remSleepSeconds: sleepLevels.remSleepSeconds,
      napSeconds: pickFiniteNumber(item, ["napDurationInSeconds", "napsDurationInSeconds"]),
      sleepScore: pickFiniteNumber(item, ["sleepScore", "sleepScores.overall"]),
      unmeasurableSleepSeconds: pickFiniteNumber(item, ["unmeasurableSleepDurationInSeconds"]),
      respirationRate: pickFiniteNumber(item, ["averageRespiration", "avgRespiration", "averageRespirationRate"]),
      startTimestamp: startInfo.sourceTimestamp || null,
      endTimestamp: endInfo.sourceTimestamp || null,
      autoDetected: typeof item.autoDetected === "boolean" ? item.autoDetected : undefined
    });
    record.units = pruneEmpty({
      sleepSeconds: actualSleepSeconds !== null ? "seconds" : null,
      awakeSeconds: awakeSeconds !== null ? "seconds" : null,
      deepSleepSeconds: sleepLevels.deepSleepSeconds !== null ? "seconds" : null,
      lightSleepSeconds: sleepLevels.lightSleepSeconds !== null ? "seconds" : null,
      remSleepSeconds: sleepLevels.remSleepSeconds !== null ? "seconds" : null,
      napSeconds: record.values.napSeconds !== undefined ? "seconds" : null,
      sleepScore: record.values.sleepScore !== undefined ? "score" : null,
      unmeasurableSleepSeconds: record.values.unmeasurableSleepSeconds !== undefined ? "seconds" : null,
      respirationRate: record.values.respirationRate !== undefined ? "breaths/min" : null
    });
    record.warnings = dedupeStrings([].concat(dateInfo.warnings, startInfo.warnings, endInfo.warnings));

    return record;
  }

  function normalizeActivityRecord(item, context, index) {
    if (!isPlainObject(item)) {
      context.fileWarnings.push("Skipped non-object activity record.");
      return null;
    }

    const startInfo = resolveDateValue(firstDefined(
      getByPath(item, "beginTimestamp"),
      getByPath(item, "startTimeLocal"),
      getByPath(item, "startTimeGMT"),
      getByPath(item, "startTimestamp"),
      getByPath(item, "activityStartTimestamp"),
      getByPath(item, "summaryStartTime")
    ), "activity start timestamp");

    const dateInfo = resolveDateValue(firstDefined(
      getByPath(item, "calendarDate"),
      getByPath(item, "date"),
      startInfo.dateKey,
      context.fileDateHint
    ), "activity date");

    if (!dateInfo.dateKey) {
      appendAll(context.fileWarnings, dateInfo.warnings);
      appendAll(context.fileWarnings, startInfo.warnings);
      context.fileWarnings.push("Skipped activity record with an invalid or missing date.");
      return null;
    }

    const activityId = firstDefined(
      getByPath(item, "activityId"),
      getByPath(item, "summaryId"),
      getByPath(item, "activityUUID"),
      getByPath(item, "uuid")
    );
    const durationSeconds = normalizeDurationSeconds(firstDefined(
      getByPath(item, "duration"),
      getByPath(item, "durationInSeconds"),
      getByPath(item, "movingDuration"),
      getByPath(item, "elapsedDuration")
    ));

    const record = createBaseRecord(FILE_KINDS.ACTIVITY, context, index, dateInfo.dateKey);
    record.sourceTimestamp = firstDefined(startInfo.sourceTimestamp, dateInfo.sourceTimestamp);
    record.upsertKey = "garmin:activity:" + (
      activityId !== undefined && activityId !== null
        ? sanitizeKeyPart(activityId)
        : [dateInfo.dateKey, sanitizeKeyPart(record.sourceTimestamp), sanitizeKeyPart(getByPath(item, "name") || getByPath(item, "activityType") || index)].join(":")
    );
    record.values = pruneEmpty({
      activityId: activityId,
      name: cleanText(firstDefined(getByPath(item, "name"), getByPath(item, "activityName"))),
      activityType: normalizeActivityType(firstDefined(getByPath(item, "activityType"), getByPath(item, "type"), getByPath(item, "sportType"))),
      durationSeconds: durationSeconds,
      distanceMeters: pickFiniteNumber(item, ["distance", "distanceInMeters", "distanceMeters"]),
      steps: pickFiniteNumber(item, ["steps", "stepCount"]),
      averageHeartRate: pickFiniteNumber(item, ["averageHeartRate", "avgHr"]),
      maxHeartRate: pickFiniteNumber(item, ["maxHeartRate"]),
      averageCadence: pickFiniteNumber(item, ["averageCadence", "avgCadence"])
    });
    record.units = pruneEmpty({
      durationSeconds: durationSeconds !== null ? "seconds" : null,
      distanceMeters: record.values.distanceMeters !== undefined ? "meters" : null,
      steps: record.values.steps !== undefined ? "count" : null,
      averageHeartRate: record.values.averageHeartRate !== undefined ? "bpm" : null,
      maxHeartRate: record.values.maxHeartRate !== undefined ? "bpm" : null,
      averageCadence: record.values.averageCadence !== undefined ? "rpm" : null
    });
    record.displayOnly = pruneEmpty({
      reportedCalories: pruneEmpty({
        value: pickFiniteNumber(item, ["totalCalories", "calories"]),
        unit: "kilocalories",
        reliability: "display-only",
        note: "Preserved for review only. Do not import as tracker daily burn."
      })
    });
    record.warnings = dedupeStrings([].concat(startInfo.warnings, dateInfo.warnings));

    return record;
  }

  function normalizeTrainingReadinessRecord(item, context, index) {
    if (!isPlainObject(item)) {
      context.fileWarnings.push("Skipped non-object training readiness record.");
      return null;
    }

    const dateInfo = resolveDateValue(firstDefined(
      getByPath(item, "calendarDate"),
      getByPath(item, "calendarDate.date"),
      getByPath(item, "date"),
      getByPath(item, "measurementDate"),
      context.fileDateHint
    ), "training readiness date");

    if (!dateInfo.dateKey) {
      appendAll(context.fileWarnings, dateInfo.warnings);
      context.fileWarnings.push("Skipped training readiness record with an invalid or missing date.");
      return null;
    }

    const record = createBaseRecord(FILE_KINDS.TRAINING_READINESS, context, index, dateInfo.dateKey);
    record.sourceTimestamp = resolveSourceTimestamp(item, [
      "lastUpdatedTimestamp",
      "lastUpdateTimestamp",
      "timestamp",
      "calendarDate",
      "date"
    ], dateInfo);
    record.upsertKey = "garmin:training-readiness:" + dateInfo.dateKey;
    record.values = pruneEmpty({
      trainingReadiness: pickFiniteNumber(item, [
        "trainingReadiness",
        "trainingReadinessScore",
        "readinessScore"
      ]),
      readinessDescription: cleanText(firstDefined(
        getByPath(item, "readinessDescription"),
        getByPath(item, "description")
      )),
      sleepScore: pickFiniteNumber(item, ["sleepScore"]),
      recoveryHours: pickFiniteNumber(item, ["recoveryTimeHours", "lastExerciseRecoveryHours"]),
      acuteLoad: pickFiniteNumber(item, ["acuteLoad"]),
      acuteLoadOptimalMin: pickFiniteNumber(item, ["acuteLoadOptimalMin"]),
      acuteLoadOptimalMax: pickFiniteNumber(item, ["acuteLoadOptimalMax"]),
      hrvStatus: cleanText(firstDefined(getByPath(item, "hrvStatus"), getByPath(item, "hrvStatusText"))),
      stressHistoryScore: pickFiniteNumber(item, ["stressHistory"]),
      sleepHistoryScore: pickFiniteNumber(item, ["sleepHistory"]),
      recentActivityHistoryScore: pickFiniteNumber(item, ["recentActivityHistory"]),
      recentRecoveryHistoryScore: pickFiniteNumber(item, ["recentRecoveryHistory"])
    });
    record.units = pruneEmpty({
      trainingReadiness: record.values.trainingReadiness !== undefined ? "score" : null,
      sleepScore: record.values.sleepScore !== undefined ? "score" : null,
      recoveryHours: record.values.recoveryHours !== undefined ? "hours" : null,
      acuteLoad: record.values.acuteLoad !== undefined ? "load" : null,
      acuteLoadOptimalMin: record.values.acuteLoadOptimalMin !== undefined ? "load" : null,
      acuteLoadOptimalMax: record.values.acuteLoadOptimalMax !== undefined ? "load" : null,
      stressHistoryScore: record.values.stressHistoryScore !== undefined ? "score" : null,
      sleepHistoryScore: record.values.sleepHistoryScore !== undefined ? "score" : null,
      recentActivityHistoryScore: record.values.recentActivityHistoryScore !== undefined ? "score" : null,
      recentRecoveryHistoryScore: record.values.recentRecoveryHistoryScore !== undefined ? "score" : null
    });
    record.warnings = dedupeStrings(dateInfo.warnings);

    return record;
  }

  function normalizeHealthStatusRecord(item, context, index) {
    if (!isPlainObject(item)) {
      context.fileWarnings.push("Skipped non-object health status record.");
      return null;
    }

    const dateInfo = resolveDateValue(firstDefined(
      getByPath(item, "calendarDate"),
      getByPath(item, "calendarDate.date"),
      getByPath(item, "statusDate"),
      getByPath(item, "measurementDate"),
      getByPath(item, "date"),
      context.fileDateHint
    ), "health status date");

    if (!dateInfo.dateKey) {
      appendAll(context.fileWarnings, dateInfo.warnings);
      context.fileWarnings.push("Skipped health status record with an invalid or missing date.");
      return null;
    }

    const weight = normalizeWeightKilograms(
      firstDefined(
        getByPath(item, "weight"),
        getByPath(item, "bodyWeight"),
        getByPath(item, "weightValue")
      ),
      firstDefined(
        getByPath(item, "weightUnit"),
        getByPath(item, "bodyWeightUnit")
      ),
      "health status weight"
    );

    const record = createBaseRecord(FILE_KINDS.HEALTH_STATUS, context, index, dateInfo.dateKey);
    record.sourceTimestamp = resolveSourceTimestamp(item, [
      "timestamp",
      "lastUpdatedTimestamp",
      "measurementTime",
      "calendarDate",
      "date"
    ], dateInfo);
    record.upsertKey = "garmin:health-status:" + dateInfo.dateKey;
    record.values = pruneEmpty({
      restingHeartRate: pickFiniteNumber(item, ["restingHeartRate", "restingHr"]),
      bodyBattery: pickFiniteNumber(item, [
        "bodyBattery",
        "bodyBatteryScore",
        "bodyBatteryMax",
        "bodyBatteryCurrent"
      ]),
      stressLevel: pickFiniteNumber(item, ["stressLevel", "averageStressLevel"]),
      sleepScore: pickFiniteNumber(item, ["sleepScore"]),
      respirationRate: pickFiniteNumber(item, ["respirationRate", "averageRespiration", "avgRespiration"]),
      hrvStatus: cleanText(firstDefined(getByPath(item, "hrvStatus"), getByPath(item, "hrvStatusText"))),
      weightKg: weight.value
    });
    record.units = pruneEmpty({
      restingHeartRate: record.values.restingHeartRate !== undefined ? "bpm" : null,
      bodyBattery: record.values.bodyBattery !== undefined ? "score" : null,
      stressLevel: record.values.stressLevel !== undefined ? "score" : null,
      sleepScore: record.values.sleepScore !== undefined ? "score" : null,
      respirationRate: record.values.respirationRate !== undefined ? "breaths/min" : null,
      weightKg: weight.value !== null ? "kg" : null
    });
    record.warnings = dedupeStrings([].concat(dateInfo.warnings, weight.warnings));

    return record;
  }

  function normalizeHydrationRecord(item, context, index) {
    if (!isPlainObject(item)) {
      context.fileWarnings.push("Skipped non-object hydration record.");
      return null;
    }

    const dateInfo = resolveDateValue(firstDefined(
      getByPath(item, "calendarDate"),
      getByPath(item, "calendarDate.date"),
      getByPath(item, "date"),
      context.fileDateHint
    ), "hydration date");

    if (!dateInfo.dateKey) {
      appendAll(context.fileWarnings, dateInfo.warnings);
      context.fileWarnings.push("Skipped hydration record with an invalid or missing date.");
      return null;
    }

    const hydration = normalizeHydrationAmount(
      firstDefined(
        getByPath(item, "totalHydration"),
        getByPath(item, "hydrationConsumedMl"),
        getByPath(item, "hydration"),
        getByPath(item, "consumed")
      ),
      firstDefined(
        getByPath(item, "unit"),
        getByPath(item, "hydrationUnit"),
        getByPath(item, "measurementUnit")
      ),
      "hydration total"
    );

    const goal = normalizeHydrationAmount(
      firstDefined(
        getByPath(item, "hydrationGoalMl"),
        getByPath(item, "goal"),
        getByPath(item, "goalHydration"),
        getByPath(item, "hydrationGoal")
      ),
      firstDefined(
        getByPath(item, "goalUnit"),
        getByPath(item, "unit"),
        getByPath(item, "hydrationUnit")
      ),
      "hydration goal"
    );

    const entries = toArray(getByPath(item, "hydrationEntries")).map(function (entry, entryIndex) {
      const entryAmount = normalizeHydrationAmount(
        firstDefined(getByPath(entry, "amount"), getByPath(entry, "hydrationAmount")),
        firstDefined(getByPath(entry, "unit"), getByPath(item, "unit")),
        "hydration entry"
      );
      const entryDate = resolveDateValue(firstDefined(
        getByPath(entry, "timestamp"),
        getByPath(entry, "loggedAt"),
        getByPath(entry, "createdAt")
      ), "hydration entry timestamp");

      return pruneEmpty({
        entryKey: sanitizeKeyPart(firstDefined(getByPath(entry, "logId"), getByPath(entry, "id"), entryIndex)),
        timestamp: entryDate.sourceTimestamp || null,
        amountMilliliters: entryAmount.value
      });
    }).filter(function (entry) {
      return entry.amountMilliliters !== undefined || entry.timestamp;
    });

    const latestEntryTimestamp = entries.reduce(function (latest, entry) {
      return entry.timestamp && (!latest || entry.timestamp > latest) ? entry.timestamp : latest;
    }, null);

    const record = createBaseRecord(FILE_KINDS.HYDRATION, context, index, dateInfo.dateKey);
    record.sourceTimestamp = latestEntryTimestamp || dateInfo.sourceTimestamp;
    record.upsertKey = "garmin:hydration:" + dateInfo.dateKey;
    record.values = pruneEmpty({
      waterMilliliters: hydration.value,
      goalMilliliters: goal.value,
      entries: entries.length ? entries : undefined
    });
    record.units = pruneEmpty({
      waterMilliliters: hydration.value !== null ? "milliliters" : null,
      goalMilliliters: goal.value !== null ? "milliliters" : null,
      entries: entries.length ? "milliliters" : null
    });
    record.warnings = dedupeStrings([].concat(dateInfo.warnings, hydration.warnings, goal.warnings));

    return record;
  }

  function buildTrackerEntryDrafts(records) {
    const draftMap = new Map();

    records.forEach(function (record) {
      if (!record.dateKey) {
        return;
      }

      const draft = ensureDraft(draftMap, record.dateKey);
      draft.sourceRecords.push({
        upsertKey: record.upsertKey,
        kind: record.kind,
        sourceTimestamp: record.sourceTimestamp,
        provenance: cloneValue(record.provenance)
      });
      appendAll(draft.warnings, record.warnings || []);

      if (record.kind === FILE_KINDS.DAILY_SUMMARY) {
        addFieldCandidate(draft, "steps", record.values.steps, "count", record, TRACKER_FIELD_PRIORITIES["daily-summary.steps"]);
        addFieldCandidate(draft, "sleepHours", secondsToHours(record.values.sleepSeconds), "hours", record, TRACKER_FIELD_PRIORITIES["daily-summary.sleepHours"]);
        addFieldCandidate(draft, "waterLiters", millilitersToLiters(record.values.waterMilliliters), "liters", record, TRACKER_FIELD_PRIORITIES["daily-summary.waterLiters"]);
        addMetricCandidate(draft, "restingHeartRate", record.values.restingHeartRate, "bpm", record, 75);
        addMetricCandidate(draft, "bodyBattery", record.values.bodyBattery, "score", record, 75);
        addMetricCandidate(draft, "stressLevel", record.values.averageStressLevel, "score", record, 75);
        if (record.displayOnly && record.displayOnly.energy) {
          draft.displayOnly.push({
            label: "Garmin daily energy",
            upsertKey: record.upsertKey,
            value: cloneValue(record.displayOnly.energy),
            reason: "Do not ingest as tracker daily burn."
          });
        }
      }

      if (record.kind === FILE_KINDS.SLEEP) {
        addFieldCandidate(draft, "sleepHours", secondsToHours(record.values.sleepSeconds), "hours", record, TRACKER_FIELD_PRIORITIES["sleep.sleepHours"]);
        addMetricCandidate(draft, "sleepScore", record.values.sleepScore, "score", record, 82);
        addMetricCandidate(draft, "respirationRate", record.values.respirationRate, "breaths/min", record, 80);
      }

      if (record.kind === FILE_KINDS.HYDRATION) {
        addFieldCandidate(draft, "waterLiters", millilitersToLiters(record.values.waterMilliliters), "liters", record, TRACKER_FIELD_PRIORITIES["hydration.waterLiters"]);
      }

      if (record.kind === FILE_KINDS.HEALTH_STATUS) {
        addFieldCandidate(draft, "weight", record.values.weightKg, "kg", record, TRACKER_FIELD_PRIORITIES["health-status.weight"]);
        addMetricCandidate(draft, "restingHeartRate", record.values.restingHeartRate, "bpm", record, TRACKER_FIELD_PRIORITIES["health-status.restingHeartRate"]);
        addMetricCandidate(draft, "bodyBattery", record.values.bodyBattery, "score", record, TRACKER_FIELD_PRIORITIES["health-status.bodyBattery"]);
        addMetricCandidate(draft, "stressLevel", record.values.stressLevel, "score", record, TRACKER_FIELD_PRIORITIES["health-status.stressLevel"]);
        addMetricCandidate(draft, "respirationRate", record.values.respirationRate, "breaths/min", record, TRACKER_FIELD_PRIORITIES["health-status.respirationRate"]);
        addMetricCandidate(draft, "sleepScore", record.values.sleepScore, "score", record, TRACKER_FIELD_PRIORITIES["health-status.sleepScore"]);
        addMetricCandidate(draft, "hrvStatus", record.values.hrvStatus, "status", record, 78);
      }

      if (record.kind === FILE_KINDS.TRAINING_READINESS) {
        addMetricCandidate(draft, "trainingReadiness", record.values.trainingReadiness, "score", record, TRACKER_FIELD_PRIORITIES["training-readiness.trainingReadiness"]);
        addMetricCandidate(draft, "sleepScore", record.values.sleepScore, "score", record, TRACKER_FIELD_PRIORITIES["training-readiness.sleepScore"]);
        addMetricCandidate(draft, "recoveryHours", record.values.recoveryHours, "hours", record, TRACKER_FIELD_PRIORITIES["training-readiness.recoveryHours"]);
        addMetricCandidate(draft, "hrvStatus", record.values.hrvStatus, "status", record, TRACKER_FIELD_PRIORITIES["training-readiness.hrvStatus"]);
      }

      if (record.kind === FILE_KINDS.ACTIVITY) {
        draft.activities.push(pruneEmpty({
          upsertKey: record.upsertKey,
          sourceTimestamp: record.sourceTimestamp,
          activityId: record.values.activityId,
          name: record.values.name,
          activityType: record.values.activityType,
          durationSeconds: record.values.durationSeconds,
          distanceMeters: record.values.distanceMeters,
          steps: record.values.steps,
          reportedCalories: record.displayOnly && record.displayOnly.reportedCalories
            ? record.displayOnly.reportedCalories.value
            : undefined
        }));

        if (record.displayOnly && record.displayOnly.reportedCalories && record.displayOnly.reportedCalories.value !== undefined) {
          draft.displayOnly.push({
            label: "Activity calories",
            upsertKey: record.upsertKey,
            value: record.displayOnly.reportedCalories.value,
            unit: "kilocalories",
            reason: "Preserved for review only. Do not ingest as tracker daily burn."
          });
        }
      }
    });

    return Array.from(draftMap.values())
      .map(finalizeDraft)
      .sort(function (first, second) {
        return first.dateKey.localeCompare(second.dateKey);
      });
  }

  function finalizeDraft(draft) {
    return {
      dateKey: draft.dateKey,
      trackerFields: finalizeBuckets(draft.trackerFields),
      importedMetrics: finalizeBuckets(draft.importedMetrics),
      activities: draft.activities.sort(function (first, second) {
        return String(first.sourceTimestamp || "").localeCompare(String(second.sourceTimestamp || ""));
      }),
      displayOnly: draft.displayOnly,
      sourceRecords: draft.sourceRecords,
      warnings: dedupeStrings(draft.warnings)
    };
  }

  function finalizeBuckets(bucketMap) {
    const result = {};
    Object.keys(bucketMap).forEach(function (key) {
      const bucket = bucketMap[key];
      if (!bucket.candidates.length) {
        return;
      }
      bucket.candidates.sort(compareCandidates);
      result[key] = {
        preferred: cloneValue(bucket.candidates[0]),
        candidates: cloneValue(bucket.candidates)
      };
    });
    return result;
  }

  function addFieldCandidate(draft, fieldName, value, unit, record, priority) {
    if (value === null || value === undefined || value === "") {
      return;
    }
    addBucketCandidate(draft.trackerFields, fieldName, value, unit, record, priority);
  }

  function addMetricCandidate(draft, fieldName, value, unit, record, priority) {
    if (value === null || value === undefined || value === "") {
      return;
    }
    addBucketCandidate(draft.importedMetrics, fieldName, value, unit, record, priority);
  }

  function addBucketCandidate(bucketMap, fieldName, value, unit, record, priority) {
    if (!bucketMap[fieldName]) {
      bucketMap[fieldName] = {
        candidates: []
      };
    }
    bucketMap[fieldName].candidates.push(pruneEmpty({
      value: value,
      unit: unit,
      priority: priority || 0,
      sourceKind: record.kind,
      sourceTimestamp: record.sourceTimestamp,
      upsertKey: record.upsertKey,
      provenance: cloneValue(record.provenance)
    }));
  }

  function compareCandidates(first, second) {
    if ((second.priority || 0) !== (first.priority || 0)) {
      return (second.priority || 0) - (first.priority || 0);
    }
    return String(second.sourceTimestamp || "").localeCompare(String(first.sourceTimestamp || ""));
  }

  function ensureDraft(map, dateKey) {
    if (!map.has(dateKey)) {
      map.set(dateKey, {
        dateKey: dateKey,
        trackerFields: {},
        importedMetrics: {},
        activities: [],
        displayOnly: [],
        sourceRecords: [],
        warnings: []
      });
    }
    return map.get(dateKey);
  }

  function createBaseRecord(kind, context, index, dateKey) {
    return {
      provider: SOURCE_PROVIDER,
      parserVersion: PARSER_VERSION,
      kind: kind,
      dateKey: dateKey,
      upsertKey: "",
      sourceTimestamp: null,
      source: {
        provider: SOURCE_PROVIDER,
        sourceType: context.classification.sourceType,
        fileKind: kind
      },
      provenance: [{
        fileName: context.fileName,
        filePath: context.filePath,
        sourceType: context.classification.sourceType,
        fileKind: kind,
        recordIndex: index
      }],
      values: {},
      units: {},
      displayOnly: {},
      warnings: []
    };
  }

  function upsertRecord(recordMap, nextRecord) {
    if (!recordMap.has(nextRecord.upsertKey)) {
      recordMap.set(nextRecord.upsertKey, nextRecord);
      return;
    }

    const currentRecord = recordMap.get(nextRecord.upsertKey);
    recordMap.set(nextRecord.upsertKey, mergeRecords(currentRecord, nextRecord));
  }

  function mergeRecords(currentRecord, nextRecord) {
    const merged = {
      provider: currentRecord.provider,
      parserVersion: nextRecord.parserVersion || currentRecord.parserVersion,
      kind: currentRecord.kind,
      dateKey: currentRecord.dateKey || nextRecord.dateKey,
      upsertKey: currentRecord.upsertKey,
      sourceTimestamp: pickLaterTimestamp(currentRecord.sourceTimestamp, nextRecord.sourceTimestamp),
      source: cloneValue(currentRecord.source || nextRecord.source),
      provenance: dedupeObjectsByJson((currentRecord.provenance || []).concat(nextRecord.provenance || [])),
      values: mergeStructuredValues(currentRecord.values, nextRecord.values),
      units: mergeStructuredValues(currentRecord.units, nextRecord.units),
      displayOnly: mergeStructuredValues(currentRecord.displayOnly, nextRecord.displayOnly),
      warnings: dedupeStrings((currentRecord.warnings || []).concat(nextRecord.warnings || []))
    };

    return merged;
  }

  function mergeStructuredValues(first, second) {
    if (Array.isArray(first) || Array.isArray(second)) {
      return cloneValue(first !== undefined && countPopulated(first) >= countPopulated(second) ? first : second);
    }
    if (isPlainObject(first) && isPlainObject(second)) {
      const merged = {};
      const keys = Object.keys(first).concat(Object.keys(second)).filter(uniqueOnly);
      keys.forEach(function (key) {
        merged[key] = mergeStructuredValues(first[key], second[key]);
      });
      return pruneEmpty(merged);
    }
    if (isPopulated(second) && (!isPopulated(first) || countPopulated(second) >= countPopulated(first))) {
      return cloneValue(second);
    }
    return cloneValue(first);
  }

  function countPopulated(value) {
    if (!isPopulated(value)) {
      return 0;
    }
    if (Array.isArray(value)) {
      return value.reduce(function (sum, item) {
        return sum + countPopulated(item);
      }, 1);
    }
    if (isPlainObject(value)) {
      return Object.keys(value).reduce(function (sum, key) {
        return sum + countPopulated(value[key]);
      }, 1);
    }
    return 1;
  }

  function classifyFile(path) {
    const normalizedPath = normalizePath(path);
    for (let index = 0; index < FILE_CLASSIFIERS.length; index += 1) {
      if (FILE_CLASSIFIERS[index].pattern.test(normalizedPath)) {
        return FILE_CLASSIFIERS[index];
      }
    }
    return {
      kind: FILE_KINDS.UNSUPPORTED,
      label: "Unsupported Garmin export file",
      sourceType: null
    };
  }

  function toFileDescriptor(input, index) {
    if (input && typeof input.text === "function" && !Object.prototype.hasOwnProperty.call(input, "textContent")) {
      return input.text().then(function (text) {
        return {
          name: input.name || ("file-" + index + ".json"),
          path: normalizePath(input.webkitRelativePath || input.path || input.name || ("file-" + index + ".json")),
          text: text
        };
      });
    }

    return Promise.resolve(normalizeDescriptorShape(input, index));
  }

  function normalizeDescriptorShape(input, index) {
    if (isPlainObject(input)) {
      return {
        name: String(input.name || basename(input.path) || ("file-" + index + ".json")),
        path: normalizePath(input.path || input.webkitRelativePath || input.name || ("file-" + index + ".json")),
        text: typeof input.text === "string" ? input.text : (typeof input.content === "string" ? input.content : null),
        json: input.json,
        hasInlineJson: Object.prototype.hasOwnProperty.call(input, "json")
      };
    }

    return {
      name: "file-" + index + ".json",
      path: "file-" + index + ".json",
      text: typeof input === "string" ? input : null,
      json: null,
      hasInlineJson: false
    };
  }

  function normalizePath(path) {
    return String(path || "").replace(/\\/g, "/");
  }

  function basename(path) {
    const normalized = normalizePath(path);
    const parts = normalized.split("/");
    return parts[parts.length - 1] || "";
  }

  function resolveSourceTimestamp(item, preferredPaths, fallbackDateInfo) {
    const values = preferredPaths.map(function (path) {
      return getByPath(item, path);
    });

    for (let index = 0; index < values.length; index += 1) {
      const dateInfo = resolveDateValue(values[index], "source timestamp");
      if (dateInfo.sourceTimestamp) {
        return dateInfo.sourceTimestamp;
      }
    }

    return fallbackDateInfo && fallbackDateInfo.sourceTimestamp ? fallbackDateInfo.sourceTimestamp : null;
  }

  function resolveDateValue(value, label) {
    const warnings = [];
    const fallback = {
      raw: value,
      dateKey: null,
      sourceTimestamp: null,
      warnings: warnings
    };

    if (value === null || value === undefined || value === "") {
      return fallback;
    }

    if (isPlainObject(value)) {
      return resolveDateValue(firstDefined(value.date, value.calendarDate, value.value, value.timestamp), label);
    }

    if (typeof value === "number") {
      const date = new Date(value > 100000000000 ? value : value * 1000);
      if (Number.isNaN(date.getTime())) {
        warnings.push("Ignored invalid numeric " + label + ".");
        return fallback;
      }
      return {
        raw: value,
        dateKey: date.toISOString().slice(0, 10),
        sourceTimestamp: date.toISOString(),
        warnings: warnings
      };
    }

    const text = String(value).trim();
    if (!text) {
      return fallback;
    }

    const isoLike = text.match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/);
    if (isoLike) {
      const dateKey = isoLike[1] + "-" + isoLike[2] + "-" + isoLike[3];
      let sourceTimestamp = dateKey;
      if (isoLike[4] !== undefined) {
        sourceTimestamp = dateKey + "T" + isoLike[4] + ":" + isoLike[5] + ":" + (isoLike[6] || "00") + (isoLike[7] || "");
      }
      return {
        raw: value,
        dateKey: dateKey,
        sourceTimestamp: sourceTimestamp,
        warnings: warnings
      };
    }

    const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (compact) {
      return {
        raw: value,
        dateKey: compact[1] + "-" + compact[2] + "-" + compact[3],
        sourceTimestamp: compact[1] + "-" + compact[2] + "-" + compact[3],
        warnings: warnings
      };
    }

    const ambiguousSlash = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (ambiguousSlash) {
      const firstPart = Number(ambiguousSlash[1]);
      const secondPart = Number(ambiguousSlash[2]);
      if (firstPart > 12 && secondPart <= 12) {
        return {
          raw: value,
          dateKey: ambiguousSlash[3] + "-" + padNumber(secondPart) + "-" + padNumber(firstPart),
          sourceTimestamp: ambiguousSlash[3] + "-" + padNumber(secondPart) + "-" + padNumber(firstPart),
          warnings: warnings
        };
      }
      if (secondPart > 12 && firstPart <= 12) {
        return {
          raw: value,
          dateKey: ambiguousSlash[3] + "-" + padNumber(firstPart) + "-" + padNumber(secondPart),
          sourceTimestamp: ambiguousSlash[3] + "-" + padNumber(firstPart) + "-" + padNumber(secondPart),
          warnings: warnings
        };
      }
      warnings.push("Ignored ambiguous " + label + " \"" + text + "\".");
      return fallback;
    }

    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) {
      return {
        raw: value,
        dateKey: parsed.toISOString().slice(0, 10),
        sourceTimestamp: parsed.toISOString(),
        warnings: warnings
      };
    }

    warnings.push("Ignored invalid " + label + " \"" + text + "\".");
    return fallback;
  }

  function padNumber(value) {
    return String(value).padStart(2, "0");
  }

  function normalizeSleepLevels(levels) {
    if (!levels) {
      return {
        deepSleepSeconds: null,
        lightSleepSeconds: null,
        remSleepSeconds: null
      };
    }

    if (Array.isArray(levels)) {
      const summary = {
        deepSleepSeconds: null,
        lightSleepSeconds: null,
        remSleepSeconds: null
      };
      levels.forEach(function (level) {
        if (!isPlainObject(level)) {
          return;
        }
        const label = cleanText(firstDefined(level.sleepLevel, level.level, level.name)).toLowerCase();
        const duration = pickFiniteNumber(level, ["durationInSeconds", "seconds", "duration"]);
        if (label === "deep") {
          summary.deepSleepSeconds = duration;
        } else if (label === "light") {
          summary.lightSleepSeconds = duration;
        } else if (label === "rem") {
          summary.remSleepSeconds = duration;
        }
      });
      return summary;
    }

    return {
      deepSleepSeconds: pickFiniteNumber(levels, ["deep", "deepSleepSeconds"]),
      lightSleepSeconds: pickFiniteNumber(levels, ["light", "lightSleepSeconds"]),
      remSleepSeconds: pickFiniteNumber(levels, ["rem", "remSleepSeconds"])
    };
  }

  function extractStressLevel(item) {
    const direct = pickFiniteNumber(item, ["allDayStress.averageStressLevel", "stressLevel"]);
    if (direct !== null) {
      return direct;
    }

    const aggregator = getByPath(item, "allDayStress.aggregatorList");
    if (Array.isArray(aggregator) && aggregator.length) {
      const level = pickFiniteNumber(aggregator[0], ["averageStressLevel"]);
      if (level !== null) {
        return level;
      }
    }

    return null;
  }

  function normalizeHydrationAmount(value, explicitUnit, label) {
    const warnings = [];
    const numberValue = toFiniteNumber(value);
    if (numberValue === null) {
      return { value: null, warnings: warnings };
    }

    const unitText = cleanText(explicitUnit).toLowerCase();
    if (unitText === "ml" || unitText === "milliliter" || unitText === "milliliters" || unitText === "millilitre" || unitText === "millilitres") {
      return { value: roundOne(numberValue), warnings: warnings };
    }
    if (unitText === "l" || unitText === "liter" || unitText === "liters" || unitText === "litre" || unitText === "litres") {
      return { value: roundOne(numberValue * 1000), warnings: warnings };
    }
    if (unitText === "oz" || unitText === "fl oz" || unitText === "fluid ounce" || unitText === "fluid ounces") {
      return { value: roundOne(numberValue * 29.5735), warnings: warnings };
    }

    if (!unitText) {
      if (numberValue > 20) {
        warnings.push("Assumed milliliters for " + label + " because no unit was provided.");
        return { value: roundOne(numberValue), warnings: warnings };
      }
      warnings.push("Assumed liters for " + label + " because the value looked too small for milliliters.");
      return { value: roundOne(numberValue * 1000), warnings: warnings };
    }

    warnings.push("Ignored unknown hydration unit \"" + explicitUnit + "\" for " + label + ".");
    return { value: null, warnings: warnings };
  }

  function normalizeWeightKilograms(value, explicitUnit, label) {
    const warnings = [];
    const numberValue = toFiniteNumber(value);
    if (numberValue === null) {
      return { value: null, warnings: warnings };
    }

    const unitText = cleanText(explicitUnit).toLowerCase();
    if (!unitText || unitText === "kg" || unitText === "kilogram" || unitText === "kilograms") {
      return { value: roundOne(numberValue), warnings: warnings };
    }
    if (unitText === "g" || unitText === "gram" || unitText === "grams") {
      return { value: roundOne(numberValue / 1000), warnings: warnings };
    }
    if (unitText === "lb" || unitText === "lbs" || unitText === "pound" || unitText === "pounds") {
      return { value: roundOne(numberValue * 0.45359237), warnings: warnings };
    }

    warnings.push("Ignored unknown weight unit \"" + explicitUnit + "\" for " + label + ".");
    return { value: null, warnings: warnings };
  }

  function normalizeMinutes(value) {
    const numberValue = toFiniteNumber(value);
    if (numberValue === null) {
      return null;
    }
    if (numberValue > 1440) {
      return roundOne(numberValue / 60);
    }
    return roundOne(numberValue);
  }

  function normalizeDurationSeconds(value) {
    const numberValue = toFiniteNumber(value);
    if (numberValue === null) {
      return null;
    }
    if (numberValue > 500000) {
      return roundOne(numberValue / 1000);
    }
    return roundOne(numberValue);
  }

  function normalizeActivityType(value) {
    const text = cleanText(value);
    return text ? text.toLowerCase() : "";
  }

  function secondsToHours(value) {
    const numberValue = toFiniteNumber(value);
    if (numberValue === null) {
      return null;
    }
    return roundOne(numberValue / 3600);
  }

  function millilitersToLiters(value) {
    const numberValue = toFiniteNumber(value);
    if (numberValue === null) {
      return null;
    }
    return roundOne(numberValue / 1000);
  }

  function pickLaterTimestamp(first, second) {
    if (!first) {
      return second || null;
    }
    if (!second) {
      return first;
    }
    return second > first ? second : first;
  }

  function getCollection(payload, preferredPaths) {
    if (Array.isArray(payload)) {
      return payload;
    }

    if (!isPlainObject(payload)) {
      return [];
    }

    for (let index = 0; index < preferredPaths.length; index += 1) {
      const value = getByPath(payload, preferredPaths[index]);
      if (Array.isArray(value)) {
        return value;
      }
      if (isPlainObject(value)) {
        return [value];
      }
    }

    return [payload];
  }

  function pickFiniteNumber(object, paths) {
    for (let index = 0; index < paths.length; index += 1) {
      const value = toFiniteNumber(getByPath(object, paths[index]));
      if (value !== null) {
        return value;
      }
    }
    return null;
  }

  function getByPath(object, path) {
    if (!object || !path) {
      return undefined;
    }
    const parts = String(path).split(".");
    let current = object;
    for (let index = 0; index < parts.length; index += 1) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[parts[index]];
    }
    return current;
  }

  function toFiniteNumber(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string") {
      const normalized = value.trim().replace(/,/g, "");
      if (!normalized) {
        return null;
      }
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function firstDefined() {
    for (let index = 0; index < arguments.length; index += 1) {
      const value = arguments[index];
      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }
    return undefined;
  }

  function extractDateFromText(text) {
    const normalized = String(text || "");
    const dashed = normalized.match(/(\d{4}-\d{2}-\d{2})/);
    if (dashed) {
      return dashed[1];
    }
    const compact = normalized.match(/(\d{8})/);
    if (compact) {
      return compact[1].slice(0, 4) + "-" + compact[1].slice(4, 6) + "-" + compact[1].slice(6, 8);
    }
    return null;
  }

  function appendAll(target, values) {
    (values || []).forEach(function (value) {
      target.push(value);
    });
  }

  function flattenRecordWarnings(records) {
    return records.reduce(function (warnings, record) {
      appendAll(warnings, record.warnings || []);
      return warnings;
    }, []);
  }

  function roundOne(value) {
    return Math.round(value * 10) / 10;
  }

  function sanitizeKeyPart(value) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "unknown";
  }

  function cleanText(value) {
    return String(value || "").trim();
  }

  function cloneValue(value) {
    if (value === undefined) {
      return undefined;
    }
    return JSON.parse(JSON.stringify(value));
  }

  function pruneEmpty(value) {
    if (Array.isArray(value)) {
      const items = value
        .map(pruneEmpty)
        .filter(function (item) {
          return isPopulated(item);
        });
      return items.length ? items : undefined;
    }

    if (isPlainObject(value)) {
      const next = {};
      Object.keys(value).forEach(function (key) {
        const nested = pruneEmpty(value[key]);
        if (isPopulated(nested)) {
          next[key] = nested;
        }
      });
      return Object.keys(next).length ? next : undefined;
    }

    return value;
  }

  function isPopulated(value) {
    if (value === null || value === undefined || value === "") {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (isPlainObject(value)) {
      return Object.keys(value).length > 0;
    }
    return true;
  }

  function isPlainObject(value) {
    return Boolean(value) && Object.prototype.toString.call(value) === "[object Object]";
  }

  function dedupeStrings(values) {
    return (values || []).filter(Boolean).filter(uniqueOnly);
  }

  function dedupeObjectsByJson(values) {
    const seen = new Set();
    return (values || []).filter(function (value) {
      const key = JSON.stringify(value);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function uniqueOnly(value, index, array) {
    return array.indexOf(value) === index;
  }

  function compareRecords(first, second) {
    if (first.dateKey !== second.dateKey) {
      return first.dateKey.localeCompare(second.dateKey);
    }
    if (first.kind !== second.kind) {
      return first.kind.localeCompare(second.kind);
    }
    return first.upsertKey.localeCompare(second.upsertKey);
  }

  function toArray(value) {
    return Array.isArray(value) ? value : [];
  }

  return {
    provider: SOURCE_PROVIDER,
    parserVersion: PARSER_VERSION,
    fileKinds: cloneValue(FILE_KINDS),
    classifyFile: classifyFile,
    importFiles: importFiles,
    normalizeFiles: normalizeFiles,
    normalizeFile: normalizeFile,
    buildTrackerEntryDrafts: buildTrackerEntryDrafts
  };
});
