import { ScheduledHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { getTierConfig } from '../shared/tier-config';

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const snsClient = new SNSClient({ region: process.env.AWS_REGION });
const cloudwatchClient = new CloudWatchClient({ region: process.env.AWS_REGION });

const API_KEYS_TABLE = process.env.API_KEYS_TABLE!;
const USAGE_METRICS_TABLE = process.env.USAGE_METRICS_TABLE!;
const CUSTOMER_ALERTS_TOPIC_ARN = process.env.CUSTOMER_ALERTS_TOPIC_ARN!;
const BILLING_EVENTS_TOPIC_ARN = process.env.BILLING_EVENTS_TOPIC_ARN!;

interface AlertThreshold {
  percentage: number;
  type: 'warning' | 'critical' | 'exceeded';
  message: string;
}

const ALERT_THRESHOLDS: AlertThreshold[] = [
  { percentage: 80, type: 'warning', message: 'You have used 80% of your monthly API quota' },
  { percentage: 95, type: 'critical', message: 'You have used 95% of your monthly API quota' },
  { percentage: 100, type: 'exceeded', message: 'You have exceeded your monthly API quota' },
];

export const handler: ScheduledHandler = async (event) => {
  console.log('Starting usage monitoring', { event });
  
  const now = new Date();
  const currentMonth = now.toISOString().substring(0, 7);
  const currentHour = now.toISOString().substring(0, 13);
  
  try {
    // Get all active API keys
    const apiKeys = await getAllActiveApiKeys();
    
    console.log(`Monitoring usage for ${apiKeys.length} API keys`);
    
    // Check usage for each API key
    const results = await Promise.allSettled(
      apiKeys.map(apiKey => checkUsageAndAlert(apiKey, currentMonth, currentHour))
    );
    
    // Count alerts sent
    const alertsSent = results.filter(r => 
      r.status === 'fulfilled' && r.value.alertSent
    ).length;
    
    console.log(`Monitoring complete: ${alertsSent} alerts sent`);
    
    // Send metrics
    await cloudwatchClient.send(new PutMetricDataCommand({
      Namespace: 'GetComplical/Usage',
      MetricData: [
        {
          MetricName: 'AlertsSent',
          Value: alertsSent,
          Unit: 'Count',
          Timestamp: new Date(),
        },
      ],
    }));
    
  } catch (error) {
    console.error('Usage monitoring failed:', error);
    throw error;
  }
};

async function getAllActiveApiKeys(): Promise<Array<{
  apiKey: string;
  customerId: string;
  userId: string;
  tier: string;
  email?: string;
  alertsEnabled?: boolean;
  lastAlertLevel?: number;
  lastAlertDate?: string;
}>> {
  const apiKeys: any[] = [];
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
      apiKeys.push(...response.Items);
    }
    
    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  
  return apiKeys;
}

async function checkUsageAndAlert(
  apiKeyInfo: any,
  currentMonth: string,
  currentHour: string
): Promise<{ alertSent: boolean; alertType?: string }> {
  const { apiKey, customerId, userId, tier, email, alertsEnabled = true } = apiKeyInfo;
  
  if (!alertsEnabled) {
    return { alertSent: false };
  }
  
  // Get tier configuration
  const tierConfig = getTierConfig(tier);
  const monthlyLimit = tierConfig.dailyLimit === -1 ? -1 : tierConfig.dailyLimit * 30;
  
  if (monthlyLimit === -1) {
    // Unlimited tier, no alerts needed
    return { alertSent: false };
  }
  
  // Get current month usage
  const usageResponse = await docClient.send(new QueryCommand({
    TableName: USAGE_METRICS_TABLE,
    KeyConditionExpression: 'pk = :pk AND sk = :sk',
    ExpressionAttributeValues: {
      ':pk': `usage#${apiKey}`,
      ':sk': `${currentMonth}#monthly`,
    },
  }));
  
  const monthlyUsage = usageResponse.Items?.[0];
  if (!monthlyUsage) {
    // No usage yet this month
    return { alertSent: false };
  }
  
  const currentUsage = monthlyUsage.totalRequests || 0;
  const usagePercentage = Math.round((currentUsage / monthlyLimit) * 100);
  
  // Check if we need to send an alert
  let alertToSend: AlertThreshold | null = null;
  
  for (const threshold of ALERT_THRESHOLDS) {
    if (usagePercentage >= threshold.percentage) {
      // Check if we already sent this alert level
      const lastAlertLevel = apiKeyInfo.lastAlertLevel || 0;
      const lastAlertDate = apiKeyInfo.lastAlertDate;
      
      // Don't send the same alert level twice in the same month
      if (lastAlertLevel < threshold.percentage || 
          !lastAlertDate || 
          !lastAlertDate.startsWith(currentMonth)) {
        alertToSend = threshold;
        break;
      }
    }
  }
  
  if (!alertToSend) {
    return { alertSent: false };
  }
  
  // Send alert
  const message = `
GetComplical API Usage Alert

${alertToSend.message}

Account Details:
- API Key: ${apiKey.substring(0, 10)}...
- Tier: ${tierConfig.name}
- Current Usage: ${currentUsage.toLocaleString()} requests
- Monthly Limit: ${monthlyLimit.toLocaleString()} requests
- Usage Percentage: ${usagePercentage}%

${alertToSend.type === 'exceeded' 
  ? 'Your API requests may be rate limited. Please upgrade your plan to continue uninterrupted service.' 
  : 'Consider upgrading your plan to ensure uninterrupted service.'}

View detailed usage: https://api.getcomplical.com/dashboard

To disable these alerts, update your notification preferences in the dashboard.
`;
  
  await snsClient.send(new PublishCommand({
    TopicArn: CUSTOMER_ALERTS_TOPIC_ARN,
    Subject: `GetComplical API Usage Alert - ${usagePercentage}% of monthly quota`,
    Message: message,
    MessageAttributes: {
      customerId: { DataType: 'String', StringValue: customerId },
      apiKey: { DataType: 'String', StringValue: apiKey },
      tier: { DataType: 'String', StringValue: tier },
      alertType: { DataType: 'String', StringValue: alertToSend.type },
      usagePercentage: { DataType: 'Number', StringValue: usagePercentage.toString() },
      email: { DataType: 'String', StringValue: email || 'unknown' },
    },
  }));
  
  // Update last alert info
  await docClient.send(new UpdateCommand({
    TableName: API_KEYS_TABLE,
    Key: { apiKey },
    UpdateExpression: 'SET lastAlertLevel = :level, lastAlertDate = :date',
    ExpressionAttributeValues: {
      ':level': alertToSend.percentage,
      ':date': currentHour,
    },
  }));
  
  // Send billing event for critical alerts
  if (alertToSend.type === 'critical' || alertToSend.type === 'exceeded') {
    await snsClient.send(new PublishCommand({
      TopicArn: BILLING_EVENTS_TOPIC_ARN,
      Subject: `Usage Alert - ${customerId} at ${usagePercentage}%`,
      Message: JSON.stringify({
        eventType: 'usage_alert',
        customerId,
        apiKey,
        tier,
        usagePercentage,
        currentUsage,
        monthlyLimit,
        alertType: alertToSend.type,
        timestamp: new Date().toISOString(),
      }),
      MessageAttributes: {
        eventType: { DataType: 'String', StringValue: 'usage_alert' },
      },
    }));
  }
  
  // Check for unusual usage patterns
  await checkUsageAnomalies(apiKey, customerId, monthlyUsage);
  
  return { alertSent: true, alertType: alertToSend.type };
}

async function checkUsageAnomalies(apiKey: string, customerId: string, monthlyUsage: any) {
  if (!monthlyUsage.dailyBreakdown) return;
  
  const dailyValues = Object.values(monthlyUsage.dailyBreakdown) as number[];
  if (dailyValues.length < 3) return; // Need at least 3 days of data
  
  // Calculate average and detect spikes
  const average = monthlyUsage.averageDaily || 0;
  const latestDay = Math.max(...dailyValues);
  
  // Alert if latest day is 5x the average (potential abuse or bug)
  if (latestDay > average * 5 && average > 100) {
    await snsClient.send(new PublishCommand({
      TopicArn: BILLING_EVENTS_TOPIC_ARN,
      Subject: `Usage Anomaly Detected - ${customerId}`,
      Message: JSON.stringify({
        eventType: 'usage_anomaly',
        customerId,
        apiKey,
        averageDaily: average,
        latestDay,
        spikeMultiplier: Math.round(latestDay / average),
        timestamp: new Date().toISOString(),
      }),
      MessageAttributes: {
        eventType: { DataType: 'String', StringValue: 'usage_anomaly' },
      },
    }));
  }
}