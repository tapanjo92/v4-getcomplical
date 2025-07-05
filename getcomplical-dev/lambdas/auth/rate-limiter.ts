import { DynamoDBDocumentClient, UpdateCommand, QueryCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';

const SHARD_COUNT = 10; // Distribute writes across 10 shards
const WINDOW_SIZE_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

export interface RateLimitResult {
  allowed: boolean;
  currentUsage: number;
  limit: number;
  resetsAt: Date;
  retryAfter?: number;
}

export interface UsageRecord {
  timestamp: number;
  count: number;
  shardId: number;
}

export class RateLimiter {
  constructor(
    private docClient: DynamoDBDocumentClient,
    private tableName: string
  ) {}

  /**
   * Check and update rate limit using sharded counters with rolling window
   */
  async checkAndUpdateLimit(
    apiKey: string,
    dailyLimit: number,
    tier: string
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - WINDOW_SIZE_MS;
    
    // Get current usage from all shards within the rolling window
    const currentUsage = await this.getUsageInWindow(apiKey, windowStart, now);
    
    if (currentUsage >= dailyLimit) {
      // Calculate when the oldest request will fall out of the window
      const oldestRequest = await this.getOldestRequestTime(apiKey, windowStart);
      const resetsAt = new Date(oldestRequest + WINDOW_SIZE_MS);
      
      return {
        allowed: false,
        currentUsage,
        limit: dailyLimit,
        resetsAt,
        retryAfter: Math.ceil((resetsAt.getTime() - now) / 1000)
      };
    }
    
    // Select random shard for write distribution
    const shardId = Math.floor(Math.random() * SHARD_COUNT);
    
    // Record the new request
    await this.recordUsage(apiKey, shardId, now);
    
    return {
      allowed: true,
      currentUsage: currentUsage + 1,
      limit: dailyLimit,
      resetsAt: new Date(now + WINDOW_SIZE_MS)
    };
  }

  /**
   * Get total usage across all shards within the time window
   */
  private async getUsageInWindow(
    apiKey: string,
    windowStart: number,
    windowEnd: number
  ): Promise<number> {
    const promises = [];
    
    // Query all shards in parallel
    for (let shardId = 0; shardId < SHARD_COUNT; shardId++) {
      const promise = this.docClient.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :pk AND #ts BETWEEN :start AND :end',
          ExpressionAttributeNames: {
            '#ts': 'timestamp'
          },
          ExpressionAttributeValues: {
            ':pk': `${apiKey}#shard#${shardId}`,
            ':start': windowStart.toString(),
            ':end': windowEnd.toString()
          },
          Select: 'COUNT'
        })
      );
      promises.push(promise);
    }
    
    const results = await Promise.all(promises);
    return results.reduce((total, result) => total + (result.Count || 0), 0);
  }

  /**
   * Record a new API usage in the specified shard
   */
  private async recordUsage(
    apiKey: string,
    shardId: number,
    timestamp: number
  ): Promise<void> {
    // Use timestamp as sort key for efficient range queries
    const pk = `${apiKey}#shard#${shardId}`;
    const sk = timestamp.toString();
    
    await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          pk,
          timestamp: timestamp.toString()
        },
        UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :one, #ttl = :ttl, apiKey = :apiKey, shardId = :shardId',
        ExpressionAttributeNames: {
          '#count': 'count',
          '#ttl': 'ttl'
        },
        ExpressionAttributeValues: {
          ':one': 1,
          ':zero': 0,
          ':ttl': Math.floor(timestamp / 1000) + (25 * 60 * 60), // Expire after 25 hours
          ':apiKey': apiKey,
          ':shardId': shardId
        }
      })
    );
  }

  /**
   * Get the timestamp of the oldest request in the current window
   */
  private async getOldestRequestTime(
    apiKey: string,
    windowStart: number
  ): Promise<number> {
    let oldestTime = Date.now();
    
    // Check each shard for the oldest entry
    for (let shardId = 0; shardId < SHARD_COUNT; shardId++) {
      const result = await this.docClient.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :pk AND #ts >= :start',
          ExpressionAttributeNames: {
            '#ts': 'timestamp'
          },
          ExpressionAttributeValues: {
            ':pk': `${apiKey}#shard#${shardId}`,
            ':start': windowStart.toString()
          },
          Limit: 1,
          ScanIndexForward: true // Get oldest first
        })
      );
      
      if (result.Items && result.Items.length > 0) {
        const timestamp = parseInt(result.Items[0].timestamp);
        if (timestamp < oldestTime) {
          oldestTime = timestamp;
        }
      }
    }
    
    return oldestTime;
  }

  /**
   * Get detailed usage statistics for monitoring
   */
  async getUsageStats(apiKey: string): Promise<{
    lastHour: number;
    last24Hours: number;
    byHour: { [hour: string]: number };
  }> {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    const oneDayAgo = now - WINDOW_SIZE_MS;
    
    const [lastHour, last24Hours] = await Promise.all([
      this.getUsageInWindow(apiKey, oneHourAgo, now),
      this.getUsageInWindow(apiKey, oneDayAgo, now)
    ]);
    
    // Get hourly breakdown
    const byHour: { [hour: string]: number } = {};
    for (let i = 0; i < 24; i++) {
      const hourStart = now - ((i + 1) * 60 * 60 * 1000);
      const hourEnd = now - (i * 60 * 60 * 1000);
      const hour = new Date(hourEnd).getUTCHours().toString().padStart(2, '0');
      byHour[hour] = await this.getUsageInWindow(apiKey, hourStart, hourEnd);
    }
    
    return { lastHour, last24Hours, byHour };
  }
}