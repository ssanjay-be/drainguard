// ============================================================
// routes/analytics.js - Analytics & Trend Analysis Endpoints
//
// GET /api/analytics/summary?device_id&days=30
//   Aggregated statistics from BOTH rod_events and raw readings.
//
// GET /api/analytics/trend?device_id&days=90
//   Linear regression on RoD ratios + water-level trend analysis
//   and downsampled water_series for charting.
// ============================================================

const express  = require('express');
const { z }    = require('zod');
const supabase = require('../lib/supabase');

const router = express.Router();

/**
 * Derives falling-water drainage intervals from chronological raw readings
 * whenever hardware rod_events have not been recorded yet.
 * A drainage segment starts at a local peak and ends when water stabilizes or bottoms out.
 */
function deriveEventsFromReadings(readings, config = {}) {
  if (!Array.isArray(readings) || readings.length < 3) return [];

  const valid = readings
    .filter(r => r.water_cm != null && r.created_at)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  if (valid.length < 3) return [];

  const baselineRod = Number(config.baseline_rod) > 0 ? Number(config.baseline_rod) : 2.5;
  const clearRatio = Number(config.clear_ratio) || 0.8;
  const preclogRatio = Number(config.preclog_ratio) || 0.5;

  const derived = [];
  let segStart = null;
  let segEnd = null;
  let steadySteps = 0;

  for (let i = 1; i < valid.length; i++) {
    const prev = valid[i - 1];
    const curr = valid[i];
    const dw = Number(prev.water_cm) - Number(curr.water_cm);

    if (dw > 0.15) {
      if (!segStart) segStart = prev;
      segEnd = curr;
      steadySteps = 0;
    } else if (segStart) {
      if (Math.abs(dw) <= 0.15 && ++steadySteps < 2) {
        segEnd = curr;
      } else {
        pushSegment(segStart, segEnd);
        segStart = null;
        segEnd = null;
        steadySteps = 0;
      }
    }
  }
  if (segStart && segEnd) {
    pushSegment(segStart, segEnd);
  }

  function pushSegment(start, end) {
    const dropCm = Number(start.water_cm) - Number(end.water_cm);
    const durS = (new Date(end.created_at) - new Date(start.created_at)) / 1000;
    if (dropCm >= 0.4 && durS >= 4) {
      const rodCmMin = dropCm / (durS / 60);
      const ratio = baselineRod > 0 ? rodCmMin / baselineRod : 1.0;
      let status = 'CLEAR';
      if (ratio < preclogRatio) status = 'PRE_CLOG';
      else if (ratio < clearRatio) status = 'WATCH';

      derived.push({
        id:             `derived-${new Date(end.created_at).getTime()}`,
        device_id:      end.device_id,
        created_at:     end.created_at,
        h1_cm:          Number(Number(start.water_cm).toFixed(2)),
        h2_cm:          Number(Number(end.water_cm).toFixed(2)),
        duration_s:     Math.round(durS),
        rod_cm_min:     Number(rodCmMin.toFixed(3)),
        baseline_rod:   baselineRod,
        ratio:          Number(ratio.toFixed(3)),
        status,
        calibration:    false,
        low_confidence: dropCm < 5 || durS < 30,
        derived:        true,
      });
    }
  }

  return derived;
}

/**
 * Downsamples chronological readings into ~maxPoints buckets for smooth chart rendering
 */
function downsampleReadings(readings, maxPoints = 120) {
  if (!Array.isArray(readings) || readings.length === 0) return [];
  const sorted = [...readings].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (sorted.length <= maxPoints) {
    return sorted.map(r => ({
      time:       r.created_at,
      created_at: r.created_at,
      water_cm:   r.water_cm,
      flood_risk: Boolean(r.flood_risk),
    }));
  }

  const step = Math.ceil(sorted.length / maxPoints);
  const out = [];
  for (let i = 0; i < sorted.length; i += step) {
    const slice = sorted.slice(i, i + step);
    const waters = slice.map(s => s.water_cm).filter(v => v != null);
    const avgWater = waters.length > 0 ? waters.reduce((a, b) => a + b, 0) / waters.length : null;
    const mid = slice[Math.floor(slice.length / 2)];
    out.push({
      time:       mid.created_at,
      created_at: mid.created_at,
      water_cm:   avgWater != null ? Number(avgWater.toFixed(2)) : null,
      flood_risk: slice.some(s => s.flood_risk),
    });
  }
  return out;
}

// ─── GET /api/analytics/summary ──────────────────────────────
router.get('/summary', async (req, res, next) => {
  try {
    const schema = z.object({
      device_id: z.string().min(1),
      days:      z.coerce.number().int().min(1).optional().default(30),
    });
    const { device_id, days } = schema.parse(req.query);

    const periodStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const prevPeriodStart = new Date(Date.now() - 2 * days * 24 * 60 * 60 * 1000).toISOString();

    // Run all 4 queries in parallel for fast response
    const [rodRes, readingsRes, prevRodRes, configRes] = await Promise.all([
      supabase
        .from('rod_events')
        .select('id, created_at, h1_cm, h2_cm, rod_cm_min, ratio, status, duration_s, calibration, low_confidence')
        .eq('device_id', device_id)
        .eq('calibration', false)
        .gte('created_at', periodStart)
        .order('created_at', { ascending: true }),
      supabase
        .from('readings')
        .select('created_at, water_cm, distance_cm, state, flood_risk, rssi, type')
        .eq('device_id', device_id)
        .gte('created_at', periodStart)
        .order('created_at', { ascending: false })
        .limit(5000),
      supabase
        .from('rod_events')
        .select('rod_cm_min')
        .eq('device_id', device_id)
        .eq('calibration', false)
        .gte('created_at', prevPeriodStart)
        .lt('created_at', periodStart),
      supabase
        .from('device_config')
        .select('*')
        .eq('device_id', device_id)
        .maybeSingle(),
    ]);

    if (rodRes.error) throw rodRes.error;
    if (readingsRes.error) throw readingsRes.error;

    const rodEvents = rodRes.data || [];
    const readings = readingsRes.data || [];
    const prevRodEvents = prevRodRes.data || [];
    const config = configRes.data || {};

    // Always compute readings-based telemetry metrics so the UI has real data
    const chronologicalReadings = [...readings].reverse();
    const derivedEvents = deriveEventsFromReadings(chronologicalReadings, config);
    const effectiveEvents = rodEvents.length > 0 ? rodEvents : derivedEvents;

    const totalRainEvents = effectiveEvents.length;
    const avgRod = totalRainEvents > 0
      ? effectiveEvents.reduce((sum, e) => sum + (e.rod_cm_min ?? 0), 0) / totalRainEvents
      : null;
    const avgRatioPct = totalRainEvents > 0
      ? (effectiveEvents.reduce((sum, e) => sum + (e.ratio ?? 0), 0) / totalRainEvents) * 100
      : null;

    const statusCounts = { CLEAR: 0, WATCH: 0, PRE_CLOG: 0 };
    effectiveEvents.forEach(e => {
      if (e.status in statusCounts) statusCounts[e.status]++;
    });

    // Telemetry depth & signal metrics from readings
    const waterLevels = readings.map(r => r.water_cm).filter(v => v != null).map(Number);
    const peakWaterCm = waterLevels.length > 0 ? Math.max(...waterLevels) : null;
    const minWaterCm  = waterLevels.length > 0 ? Math.min(...waterLevels) : null;
    const avgWaterCm  = waterLevels.length > 0
      ? Number((waterLevels.reduce((s, v) => s + v, 0) / waterLevels.length).toFixed(2))
      : null;

    const stateCounts = {};
    let floodRiskCount = 0;
    const rssiValues = [];
    for (const r of readings) {
      const st = String(r.state || 'IDLE').toUpperCase();
      stateCounts[st] = (stateCounts[st] || 0) + 1;
      if (r.flood_risk) floodRiskCount++;
      if (r.rssi != null && r.rssi !== 0) rssiValues.push(Number(r.rssi));
    }
    const avgRssi = rssiValues.length > 0
      ? Math.round(rssiValues.reduce((s, v) => s + v, 0) / rssiValues.length)
      : null;

    const durations = effectiveEvents.map(e => e.duration_s).filter(v => v != null);
    const longestDrainS = durations.length > 0 ? Math.max(...durations) : null;

    // Uptime estimation based on active 5-minute windows since first reading in period
    let uptimePct = 0;
    if (chronologicalReadings.length > 0) {
      const firstTs = new Date(chronologicalReadings[0].created_at).getTime();
      const spanMinutes = Math.max(5, (Date.now() - firstTs) / 60000);
      const totalBuckets = Math.max(1, Math.ceil(spanMinutes / 5));
      const activeBuckets = new Set(
        chronologicalReadings.map(r => Math.floor(new Date(r.created_at).getTime() / (5 * 60 * 1000)))
      ).size;
      uptimePct = Math.min(100, Math.round((activeBuckets / totalBuckets) * 100));
    }

    // Period comparison: compare previous period if available, otherwise compare earlier vs recent half of window
    let currentAvg = avgRod;
    let prevAvg = prevRodEvents.length > 0
      ? prevRodEvents.reduce((sum, e) => sum + (e.rod_cm_min ?? 0), 0) / prevRodEvents.length
      : null;

    if (prevAvg == null && effectiveEvents.length >= 2) {
      const mid = Math.floor(effectiveEvents.length / 2);
      const firstHalf = effectiveEvents.slice(0, mid);
      const secondHalf = effectiveEvents.slice(mid);
      prevAvg = firstHalf.reduce((s, e) => s + (e.rod_cm_min ?? 0), 0) / firstHalf.length;
      currentAvg = secondHalf.reduce((s, e) => s + (e.rod_cm_min ?? 0), 0) / secondHalf.length;
    }

    let changePct = null;
    if (currentAvg != null && prevAvg != null && prevAvg !== 0) {
      changePct = ((currentAvg - prevAvg) / prevAvg) * 100;
    }

    // Water depth comparison (earlier vs recent readings half) for dry/steady periods
    let waterChangePct = null;
    if (chronologicalReadings.length >= 4) {
      const mid = Math.floor(chronologicalReadings.length / 2);
      const firstWaters = chronologicalReadings.slice(0, mid).map(r => r.water_cm).filter(v => v != null);
      const secondWaters = chronologicalReadings.slice(mid).map(r => r.water_cm).filter(v => v != null);
      if (firstWaters.length > 0 && secondWaters.length > 0) {
        const w1 = firstWaters.reduce((a, b) => a + b, 0) / firstWaters.length;
        const w2 = secondWaters.reduce((a, b) => a + b, 0) / secondWaters.length;
        waterChangePct = w1 > 0.1 ? ((w2 - w1) / w1) * 100 : Number((w2 - w1).toFixed(2));
      }
    }

    let clogRiskScore = null;
    if (effectiveEvents.length >= 2 && avgRatioPct != null) {
      clogRiskScore = Math.min(100, Math.max(0, 100 - avgRatioPct));
    } else if (waterLevels.length > 0) {
      // Estimate baseline risk from standing water above rain_start_cm when no drop events exist yet
      const rainStart = Number(config.rain_start_cm) || 10;
      const latestW = Number(chronologicalReadings[chronologicalReadings.length - 1]?.water_cm ?? 0);
      clogRiskScore = latestW <= rainStart ? 5 : Math.min(85, Math.round((latestW / (Number(config.sensor_to_bottom_cm) || 60)) * 100));
    }

    res.json({
      data_source:        rodEvents.length > 0 ? 'rod_events' : (derivedEvents.length > 0 ? 'derived_readings' : 'telemetry'),
      total_rain_events:  totalRainEvents,
      hardware_events:    rodEvents.length,
      derived_events:     derivedEvents,
      avg_rod:            avgRod,
      avg_ratio_pct:      avgRatioPct,
      status_counts:      statusCounts,
      total_readings:     readings.length,
      peak_water_cm:      peakWaterCm,
      min_water_cm:       minWaterCm,
      avg_water_cm:       avgWaterCm,
      flood_risk_count:   floodRiskCount,
      avg_rssi:           avgRssi,
      state_counts:       stateCounts,
      longest_drain_s:    longestDrainS,
      uptime_pct:         uptimePct,
      month_over_month: {
        current_avg:      currentAvg,
        previous_avg:     prevAvg,
        change_pct:       changePct,
        water_change_pct: waterChangePct,
      },
      clog_risk_score:    clogRiskScore,
    });

  } catch (err) {
    next(err);
  }
});

// ─── GET /api/analytics/trend ────────────────────────────────
// Runs linear regression on RoD ratios AND water-level telemetry
// so trend charts and insights are always populated from real data.
router.get('/trend', async (req, res, next) => {
  try {
    const schema = z.object({
      device_id: z.string().min(1),
      days:      z.coerce.number().int().min(1).optional().default(90),
    });
    const { device_id, days } = schema.parse(req.query);

    const periodStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [rodRes, configRes, readingsRes] = await Promise.all([
      supabase
        .from('rod_events')
        .select('created_at, ratio, status, rod_cm_min, low_confidence')
        .eq('device_id', device_id)
        .eq('calibration', false)
        .gte('created_at', periodStart)
        .order('created_at', { ascending: true }),
      supabase
        .from('device_config')
        .select('*')
        .eq('device_id', device_id)
        .maybeSingle(),
      supabase
        .from('readings')
        .select('device_id, created_at, water_cm, distance_cm, flood_risk, state')
        .eq('device_id', device_id)
        .gte('created_at', periodStart)
        .order('created_at', { ascending: false })
        .limit(5000),
    ]);

    if (rodRes.error) throw rodRes.error;
    if (readingsRes.error) throw readingsRes.error;

    const hardwareEvents = rodRes.data || [];
    const config = configRes.data || {};
    const preclogRatio = config.preclog_ratio ?? 0.50;
    const chronologicalReadings = [...(readingsRes.data || [])].reverse();
    const waterSeries = downsampleReadings(chronologicalReadings, 120);

    // Use reliable hardware rod_events if >= 2; otherwise fall back to all rod_events or readings-derived cycles
    const reliableHardware = hardwareEvents.filter(e => !e.low_confidence);
    const derivedEvents = deriveEventsFromReadings(chronologicalReadings, config);
    const events = reliableHardware.length >= 2
      ? reliableHardware
      : (hardwareEvents.length >= 2 ? hardwareEvents : derivedEvents);

    const n = events.length;

    // Water telemetry stats for rich insight even before rain events occur
    const waters = chronologicalReadings.map(r => r.water_cm).filter(v => v != null).map(Number);
    const avgWater = waters.length > 0 ? waters.reduce((a, b) => a + b, 0) / waters.length : null;
    const peakWater = waters.length > 0 ? Math.max(...waters) : null;
    const latestWater = waters.length > 0 ? waters[waters.length - 1] : null;
    const rainStart = Number(config.rain_start_cm) || 10;

    if (n < 2) {
      let insight;
      let status = 'stable';

      if (waters.length === 0) {
        insight = `Waiting for incoming telemetry from unit ${device_id} over the past ${days} day(s).`;
      } else {
        // Compute linear water-depth trend across existing readings
        const firstHalf = waters.slice(0, Math.floor(waters.length / 2));
        const secondHalf = waters.slice(Math.floor(waters.length / 2));
        const avg1 = firstHalf.length > 0 ? firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length : latestWater;
        const avg2 = secondHalf.length > 0 ? secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length : latestWater;
        const delta = avg2 - avg1;

        if (latestWater >= rainStart && delta > 0.5) {
          status = 'declining';
          insight = `Analyzed ${waters.length} live sensor readings: water depth rose by +${delta.toFixed(1)} cm (peak ${peakWater.toFixed(1)} cm, current ${latestWater.toFixed(1)} cm). Monitoring for peak plateau to trigger RoD cycle.`;
        } else if (delta < -0.5) {
          insight = `Analyzed ${waters.length} live sensor readings: water depth is receding (${delta.toFixed(1)} cm shift; avg ${avgWater.toFixed(1)} cm, peak ${peakWater.toFixed(1)} cm). Active drainage confirmed.`;
        } else {
          insight = `Analyzed ${waters.length} live telemetry readings over ${days}d: water level is steady at ${latestWater.toFixed(1)} cm (avg ${avgWater.toFixed(1)} cm, peak ${peakWater.toFixed(1)} cm). Drain is below the ${rainStart} cm rain threshold with normal dry clearance.`;
        }
      }

      return res.json({
        events,
        water_series:                 waterSeries,
        reading_count:                waters.length,
        avg_water_cm:                 avgWater != null ? Number(avgWater.toFixed(2)) : null,
        peak_water_cm:                peakWater != null ? Number(peakWater.toFixed(2)) : null,
        slope_per_week:               null,
        r_squared:                    null,
        projected_days_until_preclog: null,
        insight:                      { text: insight, status },
      });
    }

    // Least-squares linear regression on RoD ratio series
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      const x = i;
      const y = events[i].ratio ?? 0;
      sumX  += x;
      sumY  += y;
      sumXY += x * y;
      sumX2 += x * x;
    }

    const denom = n * sumX2 - sumX * sumX;
    const slope     = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
    const intercept = (sumY - slope * sumX) / n;

    const yMean = sumY / n;
    let ssTot = 0, ssRes = 0;
    for (let i = 0; i < n; i++) {
      const y    = events[i].ratio ?? 0;
      const yHat = slope * i + intercept;
      ssTot += (y - yMean) ** 2;
      ssRes += (y - yHat) ** 2;
    }
    const rSquared = ssTot !== 0 ? 1 - ssRes / ssTot : 0;

    const daysPerEvent = Math.max(0.05, days / n);
    const slopePerDay  = slope / daysPerEvent;
    const slopePerWeek = slopePerDay * 7 * 100;

    let projectedDays = null;
    const currentRatio = events[n - 1].ratio ?? 0;

    if (slope < 0 && n >= 3 && currentRatio > preclogRatio && slopePerDay !== 0) {
      projectedDays = Math.round((currentRatio - preclogRatio) / Math.abs(slopePerDay));
    }

    let insightText;
    let insightStatus = 'stable';
    const sourceTag = hardwareEvents.length >= 2 ? 'hardware RoD events' : 'sensor-derived drop intervals';

    if (slope < 0 && projectedDays != null) {
      const declinePct = Math.abs(slopePerWeek).toFixed(1);
      insightStatus = 'declining';
      insightText = `Based on ${n} ${sourceTag} (${waters.length} readings), drainage efficiency shifted ${declinePct}%/wk; projected PRE_CLOG in ~${projectedDays} days if sediment continues accumulating.`;
    } else if (slope < 0) {
      insightStatus = 'declining';
      insightText = `Analyzed ${n} ${sourceTag} across ${waters.length} readings: slight downward velocity slope detected, still safely above PRE_CLOG threshold.`;
    } else {
      insightText = `Analyzed ${n} ${sourceTag} across ${waters.length} readings: drainage velocity is stable/healthy (latest ratio ${(currentRatio * 100).toFixed(0)}%, avg depth ${avgWater != null ? avgWater.toFixed(1) : '--'} cm).`;
    }

    res.json({
      events,
      water_series:                 waterSeries,
      reading_count:                waters.length,
      avg_water_cm:                 avgWater != null ? Number(avgWater.toFixed(2)) : null,
      peak_water_cm:                peakWater != null ? Number(peakWater.toFixed(2)) : null,
      slope_per_week:               parseFloat(slopePerWeek.toFixed(4)),
      r_squared:                    parseFloat(rSquared.toFixed(4)),
      projected_days_until_preclog: projectedDays,
      insight:                      { text: insightText, status: insightStatus },
    });

  } catch (err) {
    next(err);
  }
});

module.exports = router;
