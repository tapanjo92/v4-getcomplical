import { ScheduledHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const cloudwatchClient = new CloudWatchClient({ region: process.env.AWS_REGION });

const USAGE_METRICS_TABLE = process.env.USAGE_METRICS_TABLE!;
const API_KEYS_TABLE = process.env.API_KEYS_TABLE!;

interface UsageMetric {
  pk: string;
  sk: string;
  apiKey: string;
  customerId: string;
  date: string;
  totalRequests: number;
  endpoints?: Record<string, number>;
  tier: string;
}

interface MonthlyAggregate {
  pk: string;
  sk: string;
  apiKey: string;
  customerId: string;
  month: string;
  totalRequests: number;
  dailyBreakdown: Record<string, number>;
  endpointBreakdown: Record<string, number>;
  peakDay: { date: string; requests: number };
  averageDaily: number;
  tier: string;
  billingStatus?: 'pending' | 'processed';
}

export const handler: ScheduledHandler = async (event) => {
  console.log('Starting usage aggregation', { event });
  
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  
  const dateStr = yesterday.toISOString().split('T')[0];
  const monthStr = dateStr.substring(0, 7);
  
  try {
    // Get all API keys to process
    const apiKeys = await getAllActiveApiKeys();
    
    console.log(`Processing ${apiKeys.length} API keys for date ${dateStr}`);
    
    // Process each API key
    const results = await Promise.allSettled(
      apiKeys.map(apiKey => processApiKeyUsage(apiKey, dateStr, monthStr))
    );
    
    // Count successes and failures
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const failureCount = results.filter(r => r.status === 'rejected').length;
    
    console.log(`Aggregation complete: ${successCount} succeeded, ${failureCount} failed`);
    
    // Send metrics to CloudWatch
    await cloudwatchClient.send(new PutMetricDataCommand({
      Namespace: 'GetComplical/Usage',
      MetricData: [
        {
          MetricName: 'AggregationSuccess',
          Value: successCount,
          Unit: 'Count',
          Timestamp: new Date(),
        },
        {
          MetricName: 'AggregationFailure',
          Value: failureCount,
          Unit: 'Count',
          Timestamp: new Date(),
        },
      ],
    }));
    
  } catch (error) {
    console.error('Usage aggregation failed:', error);
    throw error;
  }
};

async function getAllActiveApiKeys(): Promise<Array<{ apiKey: string; customerId: string; tier: string }>> {
  const apiKeys: Array<{ apiKey: string; customerId: string; tier: string }> = [];
  let lastEvaluatedKey: any;
  
  do {
    const response = await docClient.send(new QueryCommand({
      TableName: API_KEYS_TABLE,
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': 'active',
      },
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    
    if (response.Items) {
      apiKeys.push(...response.Items.map(item => ({
        apiKey: item.apiKey,
        customerId: item.customerId || item.userId,
        tier: item.tier || 'free',
      })));
    }
    
    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  
  return apiKeys;
}

async function processApiKeyUsage(
  apiKeyInfo: { apiKey: string; customerId: string; tier: string },
  dateStr: string,
  monthStr: string
): Promise<void> {
  const { apiKey, customerId, tier } = apiKeyInfo;
  
  // Aggregate hourly data for the day
  const hourlyData = await getHourlyData(apiKey, monthStr, dateStr);
  
  if (hourlyData.length === 0) {
    console.log(`No usage data for ${apiKey} on ${dateStr}`);
    return;
  }
  
  // Calculate daily totals
  const dailyTotal = hourlyData.reduce((sum, hour) => sum + (hour.totalRequests || 0), 0);
  const endpointTotals: Record<string, number> = {};
  
  hourlyData.forEach(hour => {
    if (hour.endpoints) {
      Object.entries(hour.endpoints).forEach(([endpoint, count]) => {
        endpointTotals[endpoint] = (endpointTotals[endpoint] || 0) + count;
      });
    }
  });
  
  // Create daily summary (already exists from real-time tracking, but ensure consistency)
  const dailySummary = {
    pk: `usage#${apiKey}`,
    sk: `${monthStr}#daily#${dateStr}`,
    apiKey,
    customerId,
    date: dateStr,
    totalRequests: dailyTotal,
    endpoints: endpointTotals,
    tier,
    aggregatedAt: new Date().toISOString(),
  };
  
  // Update monthly aggregate
  await updateMonthlyAggregate(apiKey, customerId, tier, monthStr, dateStr, dailyTotal, endpointTotals);
  
  // Store the verified daily summary
  await docClient.send(new PutCommand({
    TableName: USAGE_METRICS_TABLE,
    Item: dailySummary,
  }));
  
  // Send usage metrics to CloudWatch for monitoring
  await sendUsageMetrics(apiKey, customerId, tier, dailyTotal);
}

async function getHourlyData(apiKey: string, monthStr: string, dateStr: string): Promise<UsageMetric[]> {
  const hourlyData: UsageMetric[] = [];
  
  // Query all hourly records for the day
  const response = await docClient.send(new QueryCommand({
    TableName: USAGE_METRICS_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `usage#${apiKey}`,
      ':skPrefix': `${monthStr}#hourly#${dateStr}`,
    },
  }));
  
  if (response.Items) {
    hourlyData.push(...response.Items as UsageMetric[]);
  }
  
  return hourlyData;
}

async function updateMonthlyAggregate(
  apiKey: string,
  customerId: string,
  tier: string,
  monthStr: string,
  dateStr: string,
  dailyTotal: number,
  endpointTotals: Record<string, number>
): Promise<void> {
  // Get current monthly aggregate
  const response = await docClient.send(new QueryCommand({
    TableName: USAGE_METRICS_TABLE,
    KeyConditionExpression: 'pk = :pk AND sk = :sk',
    ExpressionAttributeValues: {
      ':pk': `usage#${apiKey}`,
      ':sk': `${monthStr}#monthly`,
    },
  }));
  
  const existing = response.Items?.[0] as MonthlyAggregate | undefined;
  
  let monthlyAggregate: MonthlyAggregate;
  
  if (existing) {
    // Update existing monthly aggregate
    monthlyAggregate = {
      ...existing,
      totalRequests: existing.totalRequests + dailyTotal,
      dailyBreakdown: {
        ...existing.dailyBreakdown,
        [dateStr]: dailyTotal,
      },
      endpointBreakdown: mergeEndpoints(existing.endpointBreakdown, endpointTotals),
      peakDay: dailyTotal > existing.peakDay.requests 
        ? { date: dateStr, requests: dailyTotal }
        : existing.peakDay,
      averageDaily: 0, // Will calculate after
    };
  } else {
    // Create new monthly aggregate
    monthlyAggregate = {
      pk: `usage#${apiKey}`,
      sk: `${monthStr}#monthly`,
      apiKey,
      customerId,
      month: monthStr,
      totalRequests: dailyTotal,
      dailyBreakdown: { [dateStr]: dailyTotal },
      endpointBreakdown: endpointTotals,
      peakDay: { date: dateStr, requests: dailyTotal },
      averageDaily: dailyTotal,
      tier,
      billingStatus: 'pending',
    };
  }
  
  // Calculate average daily requests
  const daysWithData = Object.keys(monthlyAggregate.dailyBreakdown).length;
  monthlyAggregate.averageDaily = Math.round(monthlyAggregate.totalRequests / daysWithData);
  
  // Save updated monthly aggregate
  await docClient.send(new PutCommand({
    TableName: USAGE_METRICS_TABLE,
    Item: monthlyAggregate,
  }));
}

function mergeEndpoints(
  existing: Record<string, number>,
  newData: Record<string, number>
): Record<string, number> {
  const merged = { ...existing };
  
  Object.entries(newData).forEach(([endpoint, count]) => {
    merged[endpoint] = (merged[endpoint] || 0) + count;
  });
  
  return merged;
}

async function sendUsageMetrics(
  apiKey: string,
  customerId: string,
  tier: string,
  dailyRequests: number
): Promise<void> {
  await cloudwatchClient.send(new PutMetricDataCommand({
    Namespace: 'GetComplical/Usage',
    MetricData: [
      {
        MetricName: 'DailyRequests',
        Value: dailyRequests,
        Unit: 'Count',
        Dimensions: [
          { Name: 'ApiKey', Value: apiKey },
          { Name: 'CustomerId', Value: customerId },
          { Name: 'Tier', Value: tier },
        ],
        Timestamp: new Date(),
      },
    ],
  }));
}