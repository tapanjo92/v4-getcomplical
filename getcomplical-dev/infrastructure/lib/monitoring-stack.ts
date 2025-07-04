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
    });

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

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Requests',
        left: [apiMetrics[0]],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Errors',
        left: [apiMetrics[1], apiMetrics[2]],
        width: 12,
        height: 6,
      })
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Latency',
        left: [apiMetrics[3]],
        width: 24,
        height: 6,
      })
    );

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
      ];

      dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `${fn.functionName} Metrics`,
          left: functionMetrics,
          width: 8,
          height: 6,
        })
      );
    });

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
    });
  }
}