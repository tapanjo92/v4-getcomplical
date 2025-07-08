import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export class MonitoringStackV2 extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create SNS topic for alerts
    const alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: 'getcomplical-alerts',
      displayName: 'GetComplical Platform Alerts',
    });

    // Look up Lambda function ARNs from SSM
    const authorizerFunctionArn = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/functions/authorizer/arn'
    );
    
    const apiHandlerFunctionArn = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/functions/api-handler/arn'
    );
    
    const dashboardFunctionArn = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/functions/dashboard/arn'
    );
    
    const healthFunctionArn = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/functions/health/arn'
    );

    // Import Lambda functions
    const authorizerFunction = lambda.Function.fromFunctionArn(
      this, 'AuthorizerFunction', authorizerFunctionArn
    );
    
    const apiHandlerFunction = lambda.Function.fromFunctionArn(
      this, 'ApiHandlerFunction', apiHandlerFunctionArn
    );
    
    const dashboardFunction = lambda.Function.fromFunctionArn(
      this, 'DashboardFunction', dashboardFunctionArn
    );
    
    const healthFunction = lambda.Function.fromFunctionArn(
      this, 'HealthFunction', healthFunctionArn
    );

    // API 4XX errors
    new cloudwatch.Alarm(this, 'Api4xxAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '4XXError',
        dimensionsMap: {
          ApiName: 'GetComplical Tax API v3',
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 100,
      evaluationPeriods: 2,
      alarmDescription: 'High 4XX error rate',
      actionsEnabled: true,
    }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

    // API 5XX errors
    new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5XXError',
        dimensionsMap: {
          ApiName: 'GetComplical Tax API v3',
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      alarmDescription: 'API server errors detected',
      actionsEnabled: true,
    }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

    // Lambda error monitoring
    const lambdaFunctions = [
      { name: 'Authorizer', function: authorizerFunction },
      { name: 'ApiHandler', function: apiHandlerFunction },
      { name: 'Dashboard', function: dashboardFunction },
      { name: 'Health', function: healthFunction },
    ];

    lambdaFunctions.forEach(({ name, function: fn }) => {
      // Error rate alarm
      new cloudwatch.Alarm(this, `${name}ErrorAlarm`, {
        metric: fn.metricErrors({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 10,
        evaluationPeriods: 2,
        alarmDescription: `${name} function errors`,
        actionsEnabled: true,
      }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

      // Throttles alarm
      new cloudwatch.Alarm(this, `${name}ThrottleAlarm`, {
        metric: fn.metricThrottles({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 5,
        evaluationPeriods: 1,
        alarmDescription: `${name} function throttled`,
        actionsEnabled: true,
      }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

      // Duration alarm (for performance monitoring)
      new cloudwatch.Alarm(this, `${name}DurationAlarm`, {
        metric: fn.metricDuration({
          period: cdk.Duration.minutes(5),
          statistic: 'Average',
        }),
        threshold: 3000, // 3 seconds
        evaluationPeriods: 2,
        alarmDescription: `${name} function slow performance`,
        actionsEnabled: true,
      }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));
    });

    // Rate Limit Alarms
    new cloudwatch.Alarm(this, 'RateLimitExceededAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'GetComplical/API',
        metricName: 'RateLimitExceeded',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 100,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Alert when more than 100 rate limit errors occur in 5 minutes',
    }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

    // High API Usage Alarm
    new cloudwatch.Alarm(this, 'HighApiUsageAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'GetComplical/API',
        metricName: 'RequestCount',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 100000,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Alert when API usage exceeds 100k requests per hour',
    }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

    // Valkey/Redis monitoring
    const redisEndpoint = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/infrastructure/redis/endpoint'
    );

    // Extract cluster ID from endpoint (format: gc-valkey-prod-vX.xxxxx.cache.amazonaws.com)
    const clusterId = cdk.Fn.select(0, cdk.Fn.split('.', redisEndpoint));

    new cloudwatch.Alarm(this, 'RedisCpuAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ElastiCache',
        metricName: 'CPUUtilization',
        dimensionsMap: {
          CacheClusterId: clusterId,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80,
      evaluationPeriods: 2,
      alarmDescription: 'Valkey high CPU usage',
      actionsEnabled: true,
    }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

    new cloudwatch.Alarm(this, 'RedisConnectionsAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ElastiCache',
        metricName: 'CurrConnections',
        dimensionsMap: {
          CacheClusterId: clusterId,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5000,
      evaluationPeriods: 2,
      alarmDescription: 'Valkey high connection count',
      actionsEnabled: true,
    }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

    // DynamoDB monitoring - use fixed names since we can't use tokens in IDs
    const tables = [
      { name: ssm.StringParameter.valueForStringParameter(this, '/getcomplical/tables/api-keys/name'), id: 'ApiKeys' },
      { name: ssm.StringParameter.valueForStringParameter(this, '/getcomplical/tables/tax-data/name'), id: 'TaxData' },
      { name: ssm.StringParameter.valueForStringParameter(this, '/getcomplical/tables/rate-limit/name'), id: 'RateLimit' },
      { name: ssm.StringParameter.valueForStringParameter(this, '/getcomplical/tables/usage-metrics/name'), id: 'UsageMetrics' },
    ];

    tables.forEach(({ name, id }) => {
      new cloudwatch.Alarm(this, `${id}ThrottleAlarm`, {
        metric: new cloudwatch.Metric({
          namespace: 'AWS/DynamoDB',
          metricName: 'UserErrors',
          dimensionsMap: {
            TableName: name,
          },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 10,
        evaluationPeriods: 1,
        alarmDescription: `DynamoDB ${id} throttling`,
        actionsEnabled: true,
      }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));
    });

    // Create CloudWatch Dashboard
    const dashboard = new cloudwatch.Dashboard(this, 'MonitoringDashboard', {
      dashboardName: 'GetComplical-Monitoring',
      defaultInterval: cdk.Duration.hours(3),
    });

    // API Gateway Metrics Row
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Request Count',
        left: [new cloudwatch.Metric({
          namespace: 'AWS/ApiGateway',
          metricName: 'Count',
          dimensionsMap: { ApiName: 'GetComplical Tax API v3' },
          statistic: 'Sum',
        })],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Latency',
        left: [new cloudwatch.Metric({
          namespace: 'AWS/ApiGateway',
          metricName: 'Latency',
          dimensionsMap: { ApiName: 'GetComplical Tax API v3' },
          statistic: 'Average',
        })],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Errors',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '4XXError',
            dimensionsMap: { ApiName: 'GetComplical Tax API v3' },
            statistic: 'Sum',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '5XXError',
            dimensionsMap: { ApiName: 'GetComplical Tax API v3' },
            statistic: 'Sum',
          }),
        ],
        width: 8,
      }),
    );

    // Lambda Functions Row
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Invocations',
        left: lambdaFunctions.map(({ name, function: fn }) => 
          fn.metricInvocations({ statistic: 'Sum' })
        ),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Errors',
        left: lambdaFunctions.map(({ name, function: fn }) => 
          fn.metricErrors({ statistic: 'Sum' })
        ),
        width: 12,
      }),
    );

    // Lambda Performance Row
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Duration',
        left: lambdaFunctions.map(({ name, function: fn }) => 
          fn.metricDuration({ statistic: 'Average' })
        ),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Throttles',
        left: lambdaFunctions.map(({ name, function: fn }) => 
          fn.metricThrottles({ statistic: 'Sum' })
        ),
        width: 12,
      }),
    );

    // Business Metrics Row
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Key Operations',
        left: [
          new cloudwatch.Metric({
            namespace: 'GetComplical/Security',
            metricName: 'APIKeyOperation',
            dimensionsMap: { Action: 'CREATE_KEY' },
            statistic: 'Sum',
          }),
          new cloudwatch.Metric({
            namespace: 'GetComplical/Security',
            metricName: 'APIKeyOperation',
            dimensionsMap: { Action: 'DELETE_KEY' },
            statistic: 'Sum',
          }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Rate Limit Metrics',
        left: [
          new cloudwatch.Metric({
            namespace: 'GetComplical/API',
            metricName: 'RateLimitExceeded',
            statistic: 'Sum',
          }),
          new cloudwatch.Metric({
            namespace: 'GetComplical/API',
            metricName: 'RequestCount',
            statistic: 'Sum',
          }),
        ],
        width: 12,
      }),
    );

    // Valkey/Redis Row
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Valkey CPU',
        left: [new cloudwatch.Metric({
          namespace: 'AWS/ElastiCache',
          metricName: 'CPUUtilization',
          dimensionsMap: { CacheClusterId: clusterId },
          statistic: 'Average',
        })],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Valkey Connections',
        left: [new cloudwatch.Metric({
          namespace: 'AWS/ElastiCache',
          metricName: 'CurrConnections',
          dimensionsMap: { CacheClusterId: clusterId },
          statistic: 'Average',
        })],
        width: 12,
      }),
    );

    // DynamoDB Tables Row
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Read Capacity',
        left: tables.map(({ name, id }) => 
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ConsumedReadCapacityUnits',
            dimensionsMap: { TableName: name },
            statistic: 'Sum',
          })
        ),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Write Capacity',
        left: tables.map(({ name, id }) => 
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ConsumedWriteCapacityUnits',
            dimensionsMap: { TableName: name },
            statistic: 'Sum',
          })
        ),
        width: 12,
      }),
    );

    // Export SNS topic ARN to SSM for other stacks to use
    new ssm.StringParameter(this, 'AlertTopicArnParam', {
      parameterName: '/getcomplical/monitoring/alert-topic-arn',
      stringValue: alertTopic.topicArn,
      description: 'ARN of the monitoring alert SNS topic',
    });

    // Outputs
    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: alertTopic.topicArn,
      description: 'SNS topic for monitoring alerts',
    });

    new cdk.CfnOutput(this, 'MonitoringDashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=GetComplical-Monitoring`,
      description: 'CloudWatch Dashboard URL',
    });
  }
}