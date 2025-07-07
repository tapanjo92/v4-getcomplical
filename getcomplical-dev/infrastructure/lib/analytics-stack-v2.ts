import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export class AnalyticsStackV2 extends cdk.Stack {
  public readonly aggregationTable: dynamodb.ITable;
  public readonly alertsTable: dynamodb.ITable;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Look up resources from SSM Parameters
    const analyticsBucketName = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/infrastructure/s3/analytics-bucket'
    );
    
    const firehoseStreamName = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/infrastructure/kinesis/firehose-stream-name'
    );

    // Import the analytics bucket
    const analyticsBucket = s3.Bucket.fromBucketName(
      this, 'AnalyticsBucket', analyticsBucketName
    );

    // Import existing aggregated metrics table
    // If the table doesn't exist, the stack will fail and you'll need to create it
    this.aggregationTable = dynamodb.Table.fromTableName(
      this, 
      'AggregatedMetrics', 
      'getcomplical-aggregated-metrics'
    );

    // Import existing usage alerts table with stream
    // Note: The stream ARN includes a timestamp, so we need the actual ARN
    const alertsTableStreamArn = 'arn:aws:dynamodb:ap-south-1:809555764832:table/getcomplical-usage-alerts/stream/2025-07-06T21:57:10.972';
    
    this.alertsTable = dynamodb.Table.fromTableAttributes(
      this, 
      'UsageAlerts', 
      {
        tableName: 'getcomplical-usage-alerts',
        tableStreamArn: alertsTableStreamArn,
      }
    );

    // Create Lambda for hourly aggregation
    const aggregationLambda = new lambda.Function(this, 'AggregationFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand } = require('@aws-sdk/client-athena');

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const athenaClient = new AthenaClient({ region: process.env.AWS_REGION });

const AGGREGATION_TABLE = process.env.AGGREGATION_TABLE;
const ALERTS_TABLE = process.env.ALERTS_TABLE;
const ANALYTICS_BUCKET = process.env.ANALYTICS_BUCKET;
const DATABASE_NAME = 'getcomplical_analytics';

exports.handler = async (event) => {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  
  // Format timestamps for Athena query
  const startTime = oneHourAgo.toISOString().replace('T', ' ').substring(0, 19);
  const endTime = now.toISOString().replace('T', ' ').substring(0, 19);
  
  // Query to aggregate usage by customer for the last hour
  const query = \`
    SELECT 
      customer_id,
      tier,
      COUNT(*) as request_count,
      COUNT(DISTINCT api_key) as unique_api_keys,
      COUNT(DISTINCT endpoint) as unique_endpoints,
      AVG(response_time_ms) as avg_response_time,
      SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error_count,
      SUM(CASE WHEN cache_hit = true THEN 1 ELSE 0 END) as cache_hits
    FROM usage_events
    WHERE timestamp BETWEEN TIMESTAMP '\${startTime}' AND TIMESTAMP '\${endTime}'
    GROUP BY customer_id, tier
  \`;
  
  // Execute Athena query
  const queryExecution = await athenaClient.send(new StartQueryExecutionCommand({
    QueryString: query,
    QueryExecutionContext: { Database: DATABASE_NAME },
    ResultConfiguration: {
      OutputLocation: \`s3://\${ANALYTICS_BUCKET}/athena-results/\`,
    },
  }));
  
  // Wait for query to complete
  let queryStatus = 'RUNNING';
  while (queryStatus === 'RUNNING' || queryStatus === 'QUEUED') {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const execution = await athenaClient.send(new GetQueryExecutionCommand({
      QueryExecutionId: queryExecution.QueryExecutionId,
    }));
    queryStatus = execution.QueryExecution.Status.State;
  }
  
  if (queryStatus !== 'SUCCEEDED') {
    throw new Error(\`Query failed with status: \${queryStatus}\`);
  }
  
  // Get query results
  const results = await athenaClient.send(new GetQueryResultsCommand({
    QueryExecutionId: queryExecution.QueryExecutionId,
  }));
  
  // Process results and write to DynamoDB
  const timestamp = now.toISOString();
  const hour = timestamp.substring(0, 13);
  
  for (let i = 1; i < results.ResultSet.Rows.length; i++) {
    const row = results.ResultSet.Rows[i].Data;
    const customerId = row[0].VarCharValue;
    const tier = row[1].VarCharValue;
    const requestCount = parseInt(row[2].VarCharValue);
    const uniqueApiKeys = parseInt(row[3].VarCharValue);
    const uniqueEndpoints = parseInt(row[4].VarCharValue);
    const avgResponseTime = parseFloat(row[5].VarCharValue);
    const errorCount = parseInt(row[6].VarCharValue);
    const cacheHits = parseInt(row[7].VarCharValue);
    
    // Write hourly aggregation
    await docClient.send(new PutCommand({
      TableName: AGGREGATION_TABLE,
      Item: {
        pk: \`customer#\${customerId}\`,
        sk: \`hourly#\${hour}\`,
        customerId,
        tier,
        timestamp,
        hour,
        requestCount,
        uniqueApiKeys,
        uniqueEndpoints,
        avgResponseTime,
        errorCount,
        cacheHits,
        cacheHitRate: cacheHits / requestCount,
        errorRate: errorCount / requestCount,
        ttl: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60), // 30 days
      },
    }));
    
    // Check for usage alerts
    await checkUsageAlerts(customerId, tier, requestCount, errorRate);
  }
  
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Aggregation completed',
      recordsProcessed: results.ResultSet.Rows.length - 1,
    }),
  };
};

async function checkUsageAlerts(customerId, tier, requestCount, errorRate) {
  // Define alert thresholds by tier
  const thresholds = {
    free: { usage: 800, errorRate: 0.1 },
    pro: { usage: 8000, errorRate: 0.05 },
    enterprise: { usage: 80000, errorRate: 0.02 },
  };
  
  const threshold = thresholds[tier] || thresholds.free;
  
  // Check if usage exceeds 80% of daily limit (prorated hourly)
  const hourlyThreshold = threshold.usage / 24 * 0.8;
  
  if (requestCount > hourlyThreshold || errorRate > threshold.errorRate) {
    const alertId = \`alert-\${Date.now()}-\${Math.random().toString(36).substring(7)}\`;
    
    await docClient.send(new PutCommand({
      TableName: ALERTS_TABLE,
      Item: {
        customerId,
        alertId,
        timestamp: new Date().toISOString(),
        type: requestCount > hourlyThreshold ? 'usage_threshold' : 'error_rate',
        tier,
        details: {
          requestCount,
          threshold: hourlyThreshold,
          errorRate,
          errorThreshold: threshold.errorRate,
        },
        status: 'active',
        ttl: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60), // 7 days
      },
    }));
  }
}
      `),
      environment: {
        AGGREGATION_TABLE: this.aggregationTable.tableName,
        ALERTS_TABLE: this.alertsTable.tableName,
        ANALYTICS_BUCKET: analyticsBucketName,
      },
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
    });

    // Grant permissions
    this.aggregationTable.grantWriteData(aggregationLambda);
    this.alertsTable.grantWriteData(aggregationLambda);
    analyticsBucket.grantRead(aggregationLambda);

    // Grant Athena permissions
    aggregationLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'athena:StartQueryExecution',
        'athena:GetQueryExecution',
        'athena:GetQueryResults',
        'glue:GetDatabase',
        'glue:GetTable',
        'glue:GetPartitions',
      ],
      resources: ['*'],
    }));

    // Schedule hourly aggregation
    const hourlyRule = new events.Rule(this, 'HourlyAggregationRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      description: 'Trigger hourly usage aggregation',
    });

    hourlyRule.addTarget(new targets.LambdaFunction(aggregationLambda));

    // Create Lambda for real-time threshold monitoring
    const monitorLambda = new lambda.Function(this, 'MonitorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const snsClient = new SNSClient({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  // Process DynamoDB stream records for real-time monitoring
  for (const record of event.Records) {
    if (record.eventName === 'INSERT' && record.dynamodb.NewImage) {
      const newItem = record.dynamodb.NewImage;
      
      // Check if it's an alert record
      if (newItem.type && newItem.type.S === 'usage_threshold') {
        const customerId = newItem.customerId.S;
        const tier = newItem.tier.S;
        const requestCount = parseInt(newItem.details.M.requestCount.N);
        
        // Send SNS notification
        await snsClient.send(new PublishCommand({
          TopicArn: process.env.ALERTS_TOPIC_ARN,
          Subject: \`Usage Alert: Customer \${customerId} approaching limit\`,
          Message: JSON.stringify({
            customerId,
            tier,
            requestCount,
            timestamp: new Date().toISOString(),
            message: \`Customer \${customerId} (\${tier} tier) has used \${requestCount} requests in the last hour.\`,
          }, null, 2),
        }));
      }
    }
  }
  
  return { statusCode: 200 };
};
      `),
      environment: {
        ALERTS_TOPIC_ARN: process.env.ALERTS_TOPIC_ARN || 'arn:aws:sns:region:account:topic',
      },
      timeout: cdk.Duration.seconds(30),
    });

    // Grant permissions
    this.alertsTable.grantStreamRead(monitorLambda);
    monitorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sns:Publish'],
      resources: ['*'],
    }));

    // Streams already enabled on table creation

    // Create event source mapping
    new lambda.EventSourceMapping(this, 'AlertsStreamMapping', {
      target: monitorLambda,
      eventSourceArn: this.alertsTable.tableStreamArn!,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 10,
      maxBatchingWindow: cdk.Duration.seconds(5),
    });

    // Outputs
    new cdk.CfnOutput(this, 'AggregationTableName', {
      value: this.aggregationTable.tableName,
      description: 'DynamoDB table for aggregated metrics',
    });

    new cdk.CfnOutput(this, 'AlertsTableName', {
      value: this.alertsTable.tableName,
      description: 'DynamoDB table for usage alerts',
    });
  }
}