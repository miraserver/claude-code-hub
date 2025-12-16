import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { validateApiKeyAndGetUser, findKeyStatisticsByKeyString } from "@/repository/key";
import { RateLimitService } from "@/lib/rate-limit";
import { getResetInfoWithMode } from "@/lib/rate-limit/time-utils";
import { SessionTracker } from "@/lib/session-tracker";
import { getCombinedUserCosts } from "@/repository/statistics";

export const runtime = "nodejs";

/**
 * GET /api/key-stats
 *
 * Returns comprehensive statistics for the authenticated API key
 * Authentication: Authorization: Bearer sk-xxx
 *
 * Security: Only returns data for the specific key being used
 */
export async function GET(request: NextRequest) {
  try {
    // Extract API key from Authorization header
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Missing or invalid Authorization header. Use: Authorization: Bearer sk-xxx" },
        { status: 401 }
      );
    }

    const apiKey = authHeader.substring(7); // Remove "Bearer "

    // Validate key and get user in one query
    const result = await validateApiKeyAndGetUser(apiKey);
    if (!result) {
      return NextResponse.json(
        { error: "Invalid or expired API key" },
        { status: 401 }
      );
    }

    const { key, user } = result;

    // Get all key and user statistics in parallel (optimized: 3 DB queries instead of 8)
    const [
      thisKeyStats,
      cost5h,
      costWeekly,
      costMonthly,
      concurrentSessions,
      userCosts,
    ] = await Promise.all([
      findKeyStatisticsByKeyString(key.key, key.id),  // Optimized: no findKeyById (-1 DB)
      RateLimitService.getCurrentCost(key.id, "key", "5h"),
      // sumKeyCostTodayById removed - computed from modelStats below (-1 DB)
      RateLimitService.getCurrentCost(key.id, "key", "weekly"),
      RateLimitService.getCurrentCost(key.id, "key", "monthly"),
      SessionTracker.getKeySessionCount(key.id),
      getCombinedUserCosts(user.id, 365),  // Combined query: 5 separate queries → 1 (-4 DB)
    ]);

    // Calculate costDaily from modelStats (instead of separate sumKeyCostTodayById query)
    const costDaily = thisKeyStats.modelStats.reduce(
      (sum, m) => sum + m.totalCost, 0
    );

    // Get reset time information for daily limit
    const resetInfoDaily = getResetInfoWithMode(
      "daily",
      key.dailyResetTime,
      key.dailyResetMode ?? "fixed"
    );

    // Calculate remaining amounts
    const calculateRemaining = (limit: number | null, current: number) => {
      if (limit === null || limit === undefined) return null;
      return Math.max(0, limit - current);
    };

    // Return comprehensive stats
    return NextResponse.json({
      key: {
        id: key.id,
        name: key.name,
        isEnabled: key.isEnabled,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt,
        limits: {
          limit5hUsd: key.limit5hUsd,
          limitDailyUsd: key.limitDailyUsd,
          dailyResetMode: key.dailyResetMode ?? "fixed",
          dailyResetTime: key.dailyResetTime ?? "00:00",
          limitWeeklyUsd: key.limitWeeklyUsd,
          limitMonthlyUsd: key.limitMonthlyUsd,
          limitTotalUsd: key.limitTotalUsd,
          limitConcurrentSessions: key.limitConcurrentSessions,
        },
        usage: {
          cost5h: {
            current: cost5h,
            limit: key.limit5hUsd,
            remaining: calculateRemaining(key.limit5hUsd, cost5h),
          },
          costDaily: {
            current: costDaily,
            limit: key.limitDailyUsd,
            remaining: calculateRemaining(key.limitDailyUsd, costDaily),
            resetAt: resetInfoDaily.resetAt,
            resetMode: key.dailyResetMode ?? "fixed",
          },
          costWeekly: {
            current: costWeekly,
            limit: key.limitWeeklyUsd,
            remaining: calculateRemaining(key.limitWeeklyUsd, costWeekly),
          },
          costMonthly: {
            current: costMonthly,
            limit: key.limitMonthlyUsd,
            remaining: calculateRemaining(key.limitMonthlyUsd, costMonthly),
          },
          concurrentSessions: {
            current: concurrentSessions,
            limit: key.limitConcurrentSessions,
            remaining: calculateRemaining(key.limitConcurrentSessions, concurrentSessions),
          },
        },
        statistics: {
            todayCallCount: thisKeyStats.todayCallCount,
            lastUsedAt: thisKeyStats.lastUsedAt,
            lastProviderName: thisKeyStats.lastProviderName,
            modelStats: thisKeyStats.modelStats,
            tokenUsage: thisKeyStats.tokenUsage,
          },
      },
      user: {
        id: user.id,
        name: user.name,
        description: user.description,
        role: user.role,
        providerGroup: user.providerGroup,
        createdAt: user.createdAt,
        expiresAt: user.expiresAt,
        limits: {
          rpm: user.rpm,
          dailyQuota: user.dailyQuota,
          limit5hUsd: user.limit5hUsd,
          limitWeeklyUsd: user.limitWeeklyUsd,
          limitMonthlyUsd: user.limitMonthlyUsd,
          limitTotalUsd: user.limitTotalUsd,
          limitConcurrentSessions: user.limitConcurrentSessions,
        },
        usage: {
          totalCostToday: userCosts.costDaily,
          cost5h: userCosts.cost5h,
          costWeekly: userCosts.costWeekly,
          costMonthly: userCosts.costMonthly,
          totalCost: userCosts.totalCost,
        },
      },
    });
  } catch (error) {
    logger.error("Key stats API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
