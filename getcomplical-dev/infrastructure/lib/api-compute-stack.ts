import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface ApiComputeStackProps extends cdk.StackProps {
  userPool: cognito.UserPool;
  apiKeysTable: dynamodb.Table;
  taxDataTable: dynamodb.Table;
}

export class ApiComputeStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public readonly authorizerFunction: lambda.Function;
  public readonly apiHandlerFunction: lambda.Function;
  public readonly dashboardFunction: lambda.Function;
  public readonly dataLoaderFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: ApiComputeStackProps) {
    super(scope, id, props);

    // Create Lambda functions
    this.authorizerFunction = new lambda.Function(this, 'AuthorizerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'authorizer.handler',
      code: lambda.Code.fromAsset('lambdas/auth', {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash', '-c',
            'cp -r . /asset-output && cd /asset-output && npm install --production'
          ],
        },
      }),
      environment: {
        API_KEYS_TABLE: props.apiKeysTable.tableName,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
    });

    this.apiHandlerFunction = new lambda.Function(this, 'ApiHandlerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset('lambdas/api', {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash', '-c',
            'cp -r . /asset-output && cd /asset-output && npm install --production'
          ],
        },
      }),
      environment: {
        TAX_DATA_TABLE: props.taxDataTable.tableName,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      tracing: lambda.Tracing.ACTIVE,
    });

    this.dashboardFunction = new lambda.Function(this, 'DashboardFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'dashboard.handler',
      code: lambda.Code.fromAsset('lambdas/api', {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash', '-c',
            'cp -r . /asset-output && cd /asset-output && npm install --production'
          ],
        },
      }),
      environment: {
        API_KEYS_TABLE: props.apiKeysTable.tableName,
        USER_POOL_ID: props.userPool.userPoolId,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    props.apiKeysTable.grantReadWriteData(this.authorizerFunction);
    props.apiKeysTable.grantReadWriteData(this.dashboardFunction);
    props.taxDataTable.grantReadData(this.apiHandlerFunction);

    this.dashboardFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:GetUser'],
      resources: [props.userPool.userPoolArn],
    }));

    // Create Data Loader function
    this.dataLoaderFunction = new lambda.Function(this, 'DataLoaderFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambdas/data-loader', {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash', '-c',
            'cp -r . /asset-output && cd /asset-output && npm install --production'
          ],
        },
      }),
      environment: {
        TAX_DATA_TABLE: props.taxDataTable.tableName,
      },
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant write permissions to tax data table
    props.taxDataTable.grantWriteData(this.dataLoaderFunction);

    // Create API Gateway
    this.api = new apigateway.RestApi(this, 'GetComplicalApi', {
      restApiName: 'GetComplical Tax API',
      description: 'Tax calendar API for Australia and New Zealand',
      deployOptions: {
        stageName: 'v1',
        tracingEnabled: true,
        dataTraceEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        metricsEnabled: true,
        throttlingBurstLimit: 5000,
        throttlingRateLimit: 1000,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'X-Api-Key', 'Authorization'],
      },
    });

    const authorizer = new apigateway.TokenAuthorizer(this, 'ApiKeyAuthorizer', {
      handler: this.authorizerFunction,
      identitySource: 'method.request.header.X-Api-Key',
      resultsCacheTtl: cdk.Duration.minutes(5),
    });

    const apiResource = this.api.root.addResource('api');
    const v1Resource = apiResource.addResource('v1');
    const taxDatesResource = v1Resource.addResource('tax-dates');

    taxDatesResource.addMethod('GET', new apigateway.LambdaIntegration(this.apiHandlerFunction), {
      authorizer,
      requestParameters: {
        'method.request.querystring.country': true,
        'method.request.querystring.year': true,
        'method.request.querystring.type': false,
      },
      requestValidatorOptions: {
        requestValidatorName: 'ValidateQueryParams',
        validateRequestParameters: true,
      },
    });

    const dashboardResource = this.api.root.addResource('dashboard');
    const dashboardIntegration = new apigateway.LambdaIntegration(this.dashboardFunction);

    dashboardResource.addResource('keys').addMethod('GET', dashboardIntegration, {
      authorizationType: apigateway.AuthorizationType.IAM,
    });

    dashboardResource.addResource('generate-key').addMethod('POST', dashboardIntegration, {
      authorizationType: apigateway.AuthorizationType.IAM,
    });

    const usagePlan = this.api.addUsagePlan('BasicUsagePlan', {
      name: 'Basic',
      description: 'Basic usage plan with 1000 requests per day',
      throttle: {
        rateLimit: 10,
        burstLimit: 20,
      },
      quota: {
        limit: 1000,
        period: apigateway.Period.DAY,
      },
    });

    usagePlan.addApiStage({
      stage: this.api.deploymentStage,
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'API Gateway URL',
    });

    new cdk.CfnOutput(this, 'DataLoaderFunctionName', {
      value: this.dataLoaderFunction.functionName,
      description: 'Data Loader Lambda function name',
    });
  }
}