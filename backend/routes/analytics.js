// ============================================================
// routes/analytics.js - Analytics & Trend Analysis Endpoints
//
// GET /api/analytics/summary?device_id&days=30
//   Aggregated statistics for a device over a time period.
//
// GET /api/analytics/trend?device_id&days=90
//   Linear regression on RoD ratios to predict future clogging.
// ============================================================

const express  = require('express');
const { z }    = require('zod');
const supabase = require('../lib/supabase');

const router = express.Router();

// ─── GET /api/analytics/summary ──────────────────────────────
router.get('/summary', async (req, res, next) => {
  try {
    // Validate query params
    const schema = z.object({
      device_id: z.string().min(1),
      days:      z.coerce.number().int().min(1).optional().default(30),
    });
    const { device_id, days } = schema.parse(req.query);

    // Calculate the start of the period
    const periodStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    // Also calculate the start of the PREVIOUS period (for month-over-month comparison)
    const prevPeriodStart = new Date(Date.now() - 2 * days * 24 * 60 * 60 * 1000).toISOString();

    // ── Rod Events for this period ────────────────────────
    const { data: rodEvents, error: rodError } = await supabase
      .from('rod_events')
      .select('rod_cm_min, ratio, status, duration_s, calibration')
      .eq('device_id', device_id)
      .eq('calibration', false) // exclude calibration runs from stats
      .gte('created_at', periodStart);

    if (rodError) throw rodError;

    // ── Readings for this period ──────────────────────────
    const { data: readings, error: readError } = await supabase
      .from('readings')
      .select('water_cm, type')
      .eq('device_id', device_id)
      .gte('created_at', periodStart);

    if (readError) throw readError;

    // ── Rod Events for the PREVIOUS period (for MoM comparison) ──
    const { data: prevRodEvents } = await supabase
      .from('rod_events')
      .select('rod_cm_min')
      .eq('device_id', device_id)
      .eq('calibration', false)
      .gte('created_at', prevPeriodStart)
      .lt('created_at', periodStart);

    // ── Compute Statistics ────────────────────────────────

    // Total rain events
    const totalRainEvents = rodEvents.length;

    // Average RoD rate (cm/min)
    const avgRod = totalRainEvents > 0
      ? rodEvents.reduce((sum, e) => sum + (e.rod_cm_min ?? 0), 0) / totalRainEvents
      : null;

    // Average ratio as a percentage
    const avgRatioPct = totalRainEvents > 0
      ? rodEvents.reduce((sum, e) => sum + (e.ratio ?? 0), 0) / totalRainEvents * 100
      : null;

    // Count of events by status
    const statusCounts = { CLEAR: 0, WATCH: 0, PRE_CLOG: 0 };
    rodEvents.forEach(e => {
      if (e.status in statusCounts) statusCounts[e.status]++;
    });

    // Peak water level this period
    const waterLevels = readings.map(r => r.water_cm).filter(v => v != null);
    const peakWaterCm = waterLevels.length > 0 ? Math.max(...waterLevels) : null;

    // Longest drainage test this period
    const durations = rodEvents.map(e => e.duration_s).filter(v => v != null);
    const longestDrainS = durations.length > 0 ? Math.max(...durations) : null;

    // ── Uptime Estimation ─────────────────────────────────
    // Approximate: count readings/heartbeats in period / expected (1 per min)
    const totalMinutesInPeriod = days * 24 * 60;
    const actualRows = readings.length;
    const uptimePct = Math.min(100, Math.round((actualRows / totalMinutesInPeriod) * 100));

    // ── Month-over-Month Comparison ───────────────────────
    const currentAvg = avgRod;
    const prevAvg = prevRodEvents && prevRodEvents.length > 0
      ? prevRodEvents.reduce((sum, e) => sum + (e.rod_cm_min ?? 0), 0) / prevRodEvents.length
      : null;

    let changePct = null;
    if (currentAvg != null && prevAvg != null && prevAvg !== 0) {
      changePct = ((currentAvg - prevAvg) / prevAvg) * 100;
    }

    // ── Clog Risk Score ────────────────────────────────────
    // Requires at least 4 events for a meaningful score.
    // Score = how far from baseline the drain is (100 = totally blocked).
    let clogRiskScore = null;
    if (totalRainEvents >= 4 && avgRatioPct != null) {
      clogRiskScore = Math.min(100, Math.max(0, 100 - avgRatioPct));
    }

    res.json({
      total_rain_events:  totalRainEvents,
      avg_rod:            avgRod,
      avg_ratio_pct:      avgRatioPct,
      status_counts:      statusCounts,
      peak_water_cm:      peakWaterCm,
      longest_drain_s:    longestDrainS,
      uptime_pct:         uptimePct,
      month_over_month: {
        current_avg:  currentAvg,
        previous_avg: prevAvg,
        change_pct:   changePct,
      },
      clog_risk_score:    clogRiskScore,
    });

  } catch (err) {
    next(err);
  }
});

// ─── GET /api/analytics/trend ────────────────────────────────
// Runs a linear regression on the RoD ratio over time to detect
// whether the drain is progressively getting worse. If the slope
// is negative and significant, it projects when PRE_CLOG will be reached.
router.get('/trend', async (req, res, next) => {
  try {
    const schema = z.object({
      device_id: z.string().min(1),
      days:      z.coerce.number().int().min(1).optional().default(90),
    });
    const { device_id, days } = schema.parse(req.query);

    const periodStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Fetch reliable (not low-confidence) rod events in the period
    const { data: events, error } = await supabase
      .from('rod_events')
      .select('created_at, ratio, status, rod_cm_min')
      .eq('device_id', device_id)
      .eq('calibration', false)
      .eq('low_confidence', false)
      .gte('created_at', periodStart)
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Fetch the PRE_CLOG threshold ratio from device_config
    const { data: config } = await supabase
      .from('device_config')
      .select('preclog_ratio')
      .eq('device_id', device_id)
      .maybeSingle();

    const preclogRatio = config?.preclog_ratio ?? 0.50;

    // ── Linear Regression ─────────────────────────────────
    // We treat each event's index (0, 1, 2 ...) as x,
    // and its ratio as y, then fit y = mx + b using least squares.
    const n = events.length;

    if (n < 2) {
      // Not enough data to compute a trend
      return res.json({
        events,
        slope_per_week:               null,
        r_squared:                    null,
        projected_days_until_preclog: null,
        insight:                      'Not enough data to compute a trend (need at least 2 valid rain events).',
      });
    }

    // Compute sums needed for least-squares regression
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
      const x = i;
      const y = events[i].ratio ?? 0;
      sumX  += x;
      sumY  += y;
      sumXY += x * y;
      sumX2 += x * x;
      sumY2 += y * y;
    }

    // Slope m = (n*sumXY - sumX*sumY) / (n*sumX2 - sumX^2)
    const denom = n * sumX2 - sumX * sumX;
    const slope     = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
    const intercept = (sumY - slope * sumX) / n;

    // R² = correlation coefficient squared (how well the line fits the data)
    const yMean = sumY / n;
    let ssTot = 0, ssRes = 0;
    for (let i = 0; i < n; i++) {
      const y    = events[i].ratio ?? 0;
      const yHat = slope * i + intercept;
      ssTot += (y - yMean) ** 2;
      ssRes += (y - yHat) ** 2;
    }
    const rSquared = ssTot !== 0 ? 1 - ssRes / ssTot : 0;

    // ── Project days until PRE_CLOG ───────────────────────
    // slope_per_day: how much ratio changes per event, converted to per day
    // days_per_event = total days / number of events
    const daysPerEvent = days / n;
    const slopePerDay  = slope / daysPerEvent;  // ratio change per calendar day

    // slope_per_week expressed as percentage points (for readability)
    const slopePerWeek = slopePerDay * 7 * 100;

    let projectedDays = null;
    const currentRatio = events[n - 1].ratio ?? 0;

    // Only project if trend is downward, we have enough data, and ratio
    // hasn't already crossed the threshold
    if (slope < 0 && n >= 4 && currentRatio > preclogRatio && slopePerDay !== 0) {
      // How many more days until ratio reaches preclogRatio?
      projectedDays = Math.round((currentRatio - preclogRatio) / Math.abs(slopePerDay));
    }

    // ── Generate Human-Readable Insight ──────────────────
    let insight;
    if (slope < 0 && projectedDays != null) {
      const declinePct = Math.abs(slopePerWeek).toFixed(1);
      insight = `Drainage efficiency fell ${declinePct}% per week over the last ${days} days; ` +
                `at this rate expect PRE_CLOG in ~${projectedDays} days.`;
    } else if (slope < 0) {
      insight = `Drainage efficiency is declining but not yet close to the PRE_CLOG threshold.`;
    } else {
      insight = `Drainage efficiency is stable or improving.`;
    }

    res.json({
      events,
      slope_per_week:               parseFloat(slopePerWeek.toFixed(4)),
      r_squared:                    parseFloat(rSquared.toFixed(4)),
      projected_days_until_preclog: projectedDays,
      insight,
    });

  } catch (err) {
    next(err);
  }
});

module.exports = router;
