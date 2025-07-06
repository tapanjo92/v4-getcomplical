import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';

interface BillingStackProps extends cdk.StackProps {
  apiKeysTable: dynamodb.Table;
  usageMetricsTable: dynamodb.Table;
  stripeWebhookSecret: secretsmanager.Secret;
  paddleWebhookSecret: secretsmanager.Secret;
}

export class BillingStack extends cdk.Stack {
  public readonly customerAlertsTopic: sns.Topic;
  public readonly billingEventsTopic: sns.Topic;
  public readonly usageMonitorFunction: NodejsFunction;
  public readonly billingWebhookFunction: NodejsFunction;
  public readonly usageAggregatorFunction: NodejsFunction;
  
  constructor(scope: Construct, id: string, props: BillingStackProps) {
    super(scope, id, props);
    
    // Create SNS topics for alerts
    this.customerAlertsTopic = new sns.Topic(this, 'CustomerAlertsTopic', {
      topicName: 'getcomplical-customer-alerts',
      displayName: 'GetComplical Customer Usage Alerts',
    });
    
    this.billingEventsTopic = new sns.Topic(this, 'BillingEventsTopic', {
      topicName: 'getcomplical-billing-events',
      displayName: 'GetComplical Billing Events',
    });
    
    // Create usage aggregator Lambda
    this.usageAggregatorFunction = new NodejsFunction(this, 'UsageAggregatorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambdas/usage/usage-aggregator.ts'),
      handler: 'handler',
      environment: {
        USAGE_METRICS_TABLE: props.usageMetricsTable.tableName,
        API_KEYS_TABLE: props.apiKeysTable.tableName,
      },
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        minify: true,
        target: 'node20',
        sourceMap: true,
      },
    });
    
    // Create usage monitor Lambda for threshold alerts
    this.usageMonitorFunction = new NodejsFunction(this, 'UsageMonitorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambdas/usage/usage-monitor.ts'),
      handler: 'handler',
      environment: {
        USAGE_METRICS_TABLE: props.usageMetricsTable.tableName,
        API_KEYS_TABLE: props.apiKeysTable.tableName,
        CUSTOMER_ALERTS_TOPIC_ARN: this.customerAlertsTopic.topicArn,
        BILLING_EVENTS_TOPIC_ARN: this.billingEventsTopic.topicArn,
      },
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        minify: true,
        target: 'node20',
        sourceMap: true,
      },
    });
    
    // Create billing webhook Lambda
    this.billingWebhookFunction = new NodejsFunction(this, 'BillingWebhookFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambdas/billing/webhook-handler.ts'),
      handler: 'handler',
      environment: {
        API_KEYS_TABLE: props.apiKeysTable.tableName,
        BILLING_EVENTS_TOPIC_ARN: this.billingEventsTopic.topicArn,
        STRIPE_WEBHOOK_SECRET_ARN: 'will-be-set-by-secret',
        PADDLE_WEBHOOK_SECRET_ARN: 'will-be-set-by-secret',
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        minify: true,
        target: 'node20',
        sourceMap: true,
      },
    });
    
    // Grant permissions
    props.apiKeysTable.grantReadData(this.usageAggregatorFunction);
    props.usageMetricsTable.grantReadWriteData(this.usageAggregatorFunction);
    
    props.apiKeysTable.grantReadWriteData(this.usageMonitorFunction);
    props.usageMetricsTable.grantReadData(this.usageMonitorFunction);
    this.customerAlertsTopic.grantPublish(this.usageMonitorFunction);
    this.billingEventsTopic.grantPublish(this.usageMonitorFunction);
    
    props.apiKeysTable.grantReadWriteData(this.billingWebhookFunction);
    this.billingEventsTopic.grantPublish(this.billingWebhookFunction);
    
    // Grant CloudWatch metrics permissions
    const metricsPolicy = new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': 'GetComplical/Usage'
        }
      }
    });
    
    this.usageAggregatorFunction.addToRolePolicy(metricsPolicy);
    this.usageMonitorFunction.addToRolePolicy(metricsPolicy);
    
    // Grant access to billing secrets
    props.stripeWebhookSecret.grantRead(this.billingWebhookFunction);
    props.paddleWebhookSecret.grantRead(this.billingWebhookFunction);
    
    this.billingWebhookFunction.addEnvironment('STRIPE_WEBHOOK_SECRET_ARN', props.stripeWebhookSecret.secretArn);
    this.billingWebhookFunction.addEnvironment('PADDLE_WEBHOOK_SECRET_ARN', props.paddleWebhookSecret.secretArn);
    
    // Create scheduled rules
    
    // Usage aggregation - runs daily at 1 AM UTC
    const aggregationRule = new events.Rule(this, 'UsageAggregationRule', {
      ruleName: 'getcomplical-usage-aggregation',
      description: 'Trigger daily usage aggregation at 1 AM UTC',
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '1',
        day: '*',
        month: '*',
        year: '*',
      }),
    });
    
    aggregationRule.addTarget(new targets.LambdaFunction(this.usageAggregatorFunction));
    
    // Usage monitoring - runs every hour
    const monitoringRule = new events.Rule(this, 'UsageMonitoringRule', {
      ruleName: 'getcomplical-usage-monitoring',
      description: 'Check usage thresholds every hour',
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
    });
    
    monitoringRule.addTarget(new targets.LambdaFunction(this.usageMonitorFunction));
    
    // Note: Webhook endpoints need to be added to the API Gateway
    // This should be done in the ApiComputeStack to avoid circular dependencies
    // Export the Lambda functions so they can be used there
    
    // Outputs
    new cdk.CfnOutput(this, 'CustomerAlertsTopicArn', {
      value: this.customerAlertsTopic.topicArn,
      description: 'SNS topic for customer usage alerts',
    });
    
    new cdk.CfnOutput(this, 'BillingEventsTopicArn', {
      value: this.billingEventsTopic.topicArn,
      description: 'SNS topic for billing events',
    });
    
    // Webhook URLs will be output from ApiComputeStack
  }
}