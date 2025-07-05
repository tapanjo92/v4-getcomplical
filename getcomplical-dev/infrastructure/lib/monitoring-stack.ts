import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

interface MonitoringStackProps extends cdk.StackProps {
  apiName: string;
  lambdaFunctions: lambda.Function[];
}

export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const dashboard = new cloudwatch.Dashboard(this, 'GetComplicalDashboard', {
      dashboardName: 'GetComplical-Tax-API',
      periodOverride: cloudwatch.PeriodOverride.INHERIT,
      defaultInterval: cdk.Duration.hours(1),
    });

    // API Gateway Metrics
    const apiMetrics = [
      new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: 'Count',
        dimensionsMap: {
          ApiName: props.apiName,
        },
        statistic: 'Sum',
      }),
      new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '4XXError',
        dimensionsMap: {
          ApiName: props.apiName,
        },
        statistic: 'Sum',
      }),
      new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5XXError',
        dimensionsMap: {
          ApiName: props.apiName,
        },
        statistic: 'Sum',
      }),
      new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: 'Latency',
        dimensionsMap: {
          ApiName: props.apiName,
        },
        statistic: 'Average',
      }),
    ];

    // Custom Application Metrics
    const cacheMetrics = {
      AU_base: new cloudwatch.Metric({
        namespace: 'GetComplical/API',
        metricName: 'RequestCount',
        dimensionsMap: {
          QueryType: 'AU-base',
        },
        statistic: 'Sum',
      }),
      AU_filtered: new cloudwatch.Metric({
        namespace: 'GetComplical/API',
        metricName: 'RequestCount',
        dimensionsMap: {
          QueryType: 'AU-type-bas',
        },
        statistic: 'Sum',
      }),
      NZ_base: new cloudwatch.Metric({
        namespace: 'GetComplical/API',
        metricName: 'RequestCount',
        dimensionsMap: {
          QueryType: 'NZ-base',
        },
        statistic: 'Sum',
      }),
    };

    // Response Time Metrics by Query Type
    const responseTimeMetrics = {
      popular: new cloudwatch.Metric({
        namespace: 'GetComplical/API',
        metricName: 'ResponseTime',
        dimensionsMap: {
          CacheStrategy: 'popular-query',
        },
        statistic: 'Average',
      }),
      filtered: new cloudwatch.Metric({
        namespace: 'GetComplical/API',
        metricName: 'ResponseTime',
        dimensionsMap: {
          CacheStrategy: 'filtered-query',
        },
        statistic: 'Average',
      }),
    };

    // Add API Overview Row
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Request Volume',
        left: [apiMetrics[0]],
        width: 8,
        height: 6,
        leftYAxis: {
          label: 'Requests',
          showUnits: false,
        },
      }),
      new cloudwatch.GraphWidget({
        title: 'API Error Rate',
        left: [apiMetrics[1], apiMetrics[2]],
        width: 8,
        height: 6,
        leftYAxis: {
          label: 'Errors',
          showUnits: false,
        },
      }),
      new cloudwatch.GraphWidget({
        title: 'API Latency (ms)',
        left: [apiMetrics[3]],
        width: 8,
        height: 6,
        leftYAxis: {
          label: 'Latency (ms)',
          showUnits: false,
        },
      })
    );

    // Add Cache Performance Row
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Query Types Distribution',
        left: [cacheMetrics.AU_base, cacheMetrics.AU_filtered, cacheMetrics.NZ_base],
        width: 12,
        height: 6,
        stacked: true,
        leftYAxis: {
          label: 'Requests',
          showUnits: false,
        },
      }),
      new cloudwatch.GraphWidget({
        title: 'Response Time by Cache Strategy',
        left: [responseTimeMetrics.popular],
        right: [responseTimeMetrics.filtered],
        width: 12,
        height: 6,
        leftYAxis: {
          label: 'Popular Query Time (ms)',
          showUnits: false,
        },
        rightYAxis: {
          label: 'Filtered Query Time (ms)',
          showUnits: false,
        },
      })
    );

    // Add CloudFront Cache Metrics
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'CloudFront Cache Hit Ratio',
        left: [
          new cloudwatch.MathExpression({
            expression: '(hits / (hits + misses)) * 100',
            usingMetrics: {
              hits: new cloudwatch.Metric({
                namespace: 'AWS/CloudFront',
                metricName: 'CacheHitCount',
                statistic: 'Sum',
              }),
              misses: new cloudwatch.Metric({
                namespace: 'AWS/CloudFront',
                metricName: 'CacheMissCount',
                statistic: 'Sum',
              }),
            },
            label: 'Cache Hit Ratio %',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: {
          label: 'Hit Ratio %',
          min: 0,
          max: 100,
        },
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Current Cache Hit Ratio',
        metrics: [
          new cloudwatch.MathExpression({
            expression: '(hits / (hits + misses)) * 100',
            usingMetrics: {
              hits: new cloudwatch.Metric({
                namespace: 'AWS/CloudFront',
                metricName: 'CacheHitCount',
                statistic: 'Sum',
                period: cdk.Duration.hours(1),
              }),
              misses: new cloudwatch.Metric({
                namespace: 'AWS/CloudFront',
                metricName: 'CacheMissCount',
                statistic: 'Sum',
                period: cdk.Duration.hours(1),
              }),
            },
          }),
        ],
        width: 6,
        height: 6,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Total Requests Today',
        metrics: [
          new cloudwatch.Metric({
            namespace: 'GetComplical/API',
            metricName: 'RequestCount',
            statistic: 'Sum',
            period: cdk.Duration.days(1),
          }),
        ],
        width: 6,
        height: 6,
      })
    );

    // Lambda Function Metrics
    props.lambdaFunctions.forEach((fn) => {
      const functionMetrics = [
        new cloudwatch.Metric({
          namespace: 'AWS/Lambda',
          metricName: 'Invocations',
          dimensionsMap: {
            FunctionName: fn.functionName,
          },
          statistic: 'Sum',
        }),
        new cloudwatch.Metric({
          namespace: 'AWS/Lambda',
          metricName: 'Errors',
          dimensionsMap: {
            FunctionName: fn.functionName,
          },
          statistic: 'Sum',
        }),
        new cloudwatch.Metric({
          namespace: 'AWS/Lambda',
          metricName: 'Duration',
          dimensionsMap: {
            FunctionName: fn.functionName,
          },
          statistic: 'Average',
        }),
        new cloudwatch.Metric({
          namespace: 'AWS/Lambda',
          metricName: 'ConcurrentExecutions',
          dimensionsMap: {
            FunctionName: fn.functionName,
          },
          statistic: 'Maximum',
        }),
      ];

      dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `${fn.node.id} Performance`,
          left: [functionMetrics[0], functionMetrics[1]],
          right: [functionMetrics[2]],
          width: 12,
          height: 6,
          leftYAxis: {
            label: 'Count',
            showUnits: false,
          },
          rightYAxis: {
            label: 'Duration (ms)',
            showUnits: false,
          },
        })
      );
    });

    // Query Performance Analysis
    dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Top 10 Query Patterns',
        logGroupNames: props.lambdaFunctions.map(fn => `/aws/lambda/${fn.functionName}`),
        queryLines: [
          'fields @timestamp, queryType, responseTime, itemCount',
          'filter @message like /QueryType/',
          'stats count() as requests, avg(responseTime) as avgTime by queryType',
          'sort requests desc',
          'limit 10',
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.LogQueryWidget({
        title: 'Slowest Queries',
        logGroupNames: props.lambdaFunctions.map(fn => `/aws/lambda/${fn.functionName}`),
        queryLines: [
          'fields @timestamp, queryType, responseTime, itemCount',
          'filter responseTime > 100',
          'sort responseTime desc',
          'limit 20',
        ],
        width: 12,
        height: 6,
      })
    );

    // Create Alarms
    new cloudwatch.Alarm(this, 'ApiErrorAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5XXError',
        dimensionsMap: {
          ApiName: props.apiName,
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Alert when API has more than 10 5XX errors in 5 minutes',
    });

    new cloudwatch.Alarm(this, 'HighLatencyAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'GetComplical/API',
        metricName: 'ResponseTime',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1000, // 1 second
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Alert when average response time exceeds 1 second',
    });

    new cloudwatch.Alarm(this, 'LowCacheHitRatioAlarm', {
      metric: new cloudwatch.MathExpression({
        expression: '(hits / (hits + misses)) * 100',
        usingMetrics: {
          hits: new cloudwatch.Metric({
            namespace: 'AWS/CloudFront',
            metricName: 'CacheHitCount',
            statistic: 'Sum',
            period: cdk.Duration.minutes(15),
          }),
          misses: new cloudwatch.Metric({
            namespace: 'AWS/CloudFront',
            metricName: 'CacheMissCount',
            statistic: 'Sum',
            period: cdk.Duration.minutes(15),
          }),
        },
      }),
      threshold: 70, // Alert if cache hit ratio drops below 70%
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Alert when cache hit ratio drops below 70%',
    });

    // Lambda Error Alarms
    props.lambdaFunctions.forEach((fn) => {
      new cloudwatch.Alarm(this, `${fn.node.id}ErrorAlarm`, {
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Lambda',
          metricName: 'Errors',
          dimensionsMap: {
            FunctionName: fn.functionName,
          },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 5,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `Alert when ${fn.functionName} has more than 5 errors in 5 minutes`,
      });

      new cloudwatch.Alarm(this, `${fn.node.id}ThrottleAlarm`, {
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Lambda',
          metricName: 'Throttles',
          dimensionsMap: {
            FunctionName: fn.functionName,
          },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 10,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `Alert when ${fn.functionName} is throttled more than 10 times in 5 minutes`,
      });
    });

    // Output Dashboard URL
    new cdk.CfnOutput(this, 'DashboardURL', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=GetComplical-Tax-API`,
      description: 'CloudWatch Dashboard URL',
    });
  }
}