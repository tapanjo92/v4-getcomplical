import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';

interface ApiComputeStackProps extends cdk.StackProps {
  userPool: cognito.UserPool;
  apiKeysTable: dynamodb.Table;
  taxDataTable: dynamodb.Table;
  rateLimitTable: dynamodb.Table;
  usageMetricsTable: dynamodb.Table;
  billingWebhookFunction?: lambda.Function;
  usageAggregatorFunction?: lambda.Function;
  usageMonitorFunction?: lambda.Function;
}

export class ApiComputeStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public readonly authorizerFunction: NodejsFunction;
  public readonly apiHandlerFunction: NodejsFunction;
  public readonly dashboardFunction: NodejsFunction;
  public readonly dataLoaderFunction: NodejsFunction;
  public readonly healthFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiComputeStackProps) {
    super(scope, id, props);

    // Create Lambda functions
    this.authorizerFunction = new NodejsFunction(this, 'AuthorizerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambdas/auth/authorizer.ts'),
      handler: 'handler',
      environment: {
        API_KEYS_TABLE: props.apiKeysTable.tableName,
        RATE_LIMIT_TABLE: props.rateLimitTable.tableName,
        USAGE_METRICS_TABLE: props.usageMetricsTable.tableName,
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

    this.apiHandlerFunction = new NodejsFunction(this, 'ApiHandlerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambdas/api/handler.ts'),
      handler: 'handler',
      environment: {
        TAX_DATA_TABLE: props.taxDataTable.tableName,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        minify: true,
        target: 'node20',
        sourceMap: true,
      },
    });

    this.dashboardFunction = new NodejsFunction(this, 'DashboardFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambdas/api/dashboard.ts'),
      handler: 'handler',
      environment: {
        API_KEYS_TABLE: props.apiKeysTable.tableName,
        RATE_LIMIT_TABLE: props.rateLimitTable.tableName,
        USAGE_METRICS_TABLE: props.usageMetricsTable.tableName,
        USER_POOL_ID: props.userPool.userPoolId,
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

    // Create health check function
    this.healthFunction = new NodejsFunction(this, 'HealthFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambdas/api/health.ts'),
      handler: 'handler',
      environment: {
        API_KEYS_TABLE: props.apiKeysTable.tableName,
        TAX_DATA_TABLE: props.taxDataTable.tableName,
        RATE_LIMIT_TABLE: props.rateLimitTable.tableName,
        HEALTH_CHECK_KEY: 'will-be-set-by-secret',
        API_VERSION: '1.0.0',
      },
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        minify: true,
        target: 'node20',
        sourceMap: true,
      },
    });

    // Grant permissions
    props.apiKeysTable.grantReadWriteData(this.authorizerFunction);
    props.apiKeysTable.grantReadWriteData(this.dashboardFunction);
    props.taxDataTable.grantReadData(this.apiHandlerFunction);
    props.rateLimitTable.grantReadWriteData(this.authorizerFunction);
    props.rateLimitTable.grantReadData(this.dashboardFunction);
    props.usageMetricsTable.grantReadWriteData(this.authorizerFunction);
    props.usageMetricsTable.grantReadData(this.dashboardFunction);
    
    // Grant permissions for health check function
    props.apiKeysTable.grantReadData(this.healthFunction);
    props.taxDataTable.grantReadData(this.healthFunction);
    props.rateLimitTable.grantReadData(this.healthFunction);
    
    // Grant CloudWatch permissions for health check
    this.healthFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricStatistics'],
      resources: ['*'],
    }));
    
    // Grant access to health check secret
    const healthCheckSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 
      'HealthCheckSecret',
      'getcomplical/health-check-key'
    );
    healthCheckSecret.grantRead(this.healthFunction);
    
    // Add secret as environment variable
    this.healthFunction.addEnvironment('HEALTH_CHECK_SECRET_ARN', healthCheckSecret.secretArn);

    // Grant CloudWatch permissions for metrics
    this.apiHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cloudwatch:PutMetricData',
      ],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': 'GetComplical/API',
        },
      },
    }));

    this.dashboardFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:GetUser'],
      resources: [props.userPool.userPoolArn],
    }));

    // Create Data Loader function
    this.dataLoaderFunction = new NodejsFunction(this, 'DataLoaderFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambdas/data-loader/index.ts'),
      handler: 'handler',
      environment: {
        TAX_DATA_TABLE: props.taxDataTable.tableName,
      },
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        minify: false, // Keep false for data loader as it has large data files
        target: 'node20',
        sourceMap: true,
        externalModules: ['@aws-sdk/*'], // AWS SDK v3 is available in Lambda runtime
      },
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

    // Create authorizers
    const apiKeyAuthorizer = new apigateway.TokenAuthorizer(this, 'ApiKeyAuthorizer', {
      handler: this.authorizerFunction,
      identitySource: 'method.request.header.X-Api-Key',
      resultsCacheTtl: cdk.Duration.minutes(5),
    });

    // Cognito authorizer for dashboard endpoints
    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [props.userPool],
      identitySource: 'method.request.header.Authorization',
    });

    const apiResource = this.api.root.addResource('api');
    const v1Resource = apiResource.addResource('v1');
    const taxDatesResource = v1Resource.addResource('tax-dates');

    taxDatesResource.addMethod('GET', new apigateway.LambdaIntegration(this.apiHandlerFunction), {
      authorizer: apiKeyAuthorizer,
      requestParameters: {
        'method.request.querystring.country': true,
        'method.request.querystring.year': true,
        'method.request.querystring.type': false,
        'method.request.querystring.state': false,
        'method.request.querystring.agency': false,
      },
      requestValidatorOptions: {
        requestValidatorName: 'ValidateQueryParams',
        validateRequestParameters: true,
      },
    });

    const dashboardResource = this.api.root.addResource('dashboard');
    const dashboardIntegration = new apigateway.LambdaIntegration(this.dashboardFunction);

    dashboardResource.addResource('keys').addMethod('GET', dashboardIntegration, {
      authorizer: cognitoAuthorizer,
    });

    dashboardResource.addResource('generate-key').addMethod('POST', dashboardIntegration, {
      authorizer: cognitoAuthorizer,
    });

    dashboardResource.addResource('tiers').addMethod('GET', dashboardIntegration, {
      authorizer: cognitoAuthorizer,
    });
    
    // Add usage endpoints
    const usageResource = dashboardResource.addResource('usage');
    
    usageResource.addResource('monthly').addMethod('GET', dashboardIntegration, {
      authorizer: cognitoAuthorizer,
      requestParameters: {
        'method.request.querystring.month': false,
      },
    });
    
    usageResource.addResource('daily').addMethod('GET', dashboardIntegration, {
      authorizer: cognitoAuthorizer,
      requestParameters: {
        'method.request.querystring.apiKey': true,
        'method.request.querystring.startDate': false,
        'method.request.querystring.endDate': false,
      },
    });
    
    usageResource.addResource('realtime').addMethod('GET', dashboardIntegration, {
      authorizer: cognitoAuthorizer,
      requestParameters: {
        'method.request.querystring.apiKey': true,
      },
    });
    
    // Add health check endpoint
    const healthResource = this.api.root.addResource('health');
    healthResource.addMethod('GET', new apigateway.LambdaIntegration(this.healthFunction), {
      requestParameters: {
        'method.request.querystring.deep': false,
      },
      methodResponses: [{
        statusCode: '200',
        responseParameters: {
          'method.response.header.X-Health-Status': true,
        },
      }, {
        statusCode: '503',
        responseParameters: {
          'method.response.header.X-Health-Status': true,
        },
      }],
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

    // Add webhook endpoints if billing functions are provided
    if (props.billingWebhookFunction) {
      const webhooksResource = this.api.root.addResource('webhooks');
      
      webhooksResource.addResource('stripe').addMethod('POST', 
        new apigateway.LambdaIntegration(props.billingWebhookFunction),
        {
          methodResponses: [{
            statusCode: '200',
          }, {
            statusCode: '400',
          }],
        }
      );
      
      webhooksResource.addResource('paddle').addMethod('POST', 
        new apigateway.LambdaIntegration(props.billingWebhookFunction),
        {
          methodResponses: [{
            statusCode: '200',
          }, {
            statusCode: '400',
          }],
        }
      );
    }
    
    // Add admin endpoints if monitoring functions are provided
    if (props.usageAggregatorFunction && props.usageMonitorFunction) {
      const adminResource = this.api.root.addResource('admin');
      
      adminResource.addResource('trigger-aggregation').addMethod('POST',
        new apigateway.LambdaIntegration(props.usageAggregatorFunction),
        {
          apiKeyRequired: true,
        }
      );
      
      adminResource.addResource('trigger-monitoring').addMethod('POST',
        new apigateway.LambdaIntegration(props.usageMonitorFunction),
        {
          apiKeyRequired: true,
        }
      );
      
      // Create API key for admin access
      const adminApiKey = this.api.addApiKey('AdminApiKey', {
        apiKeyName: 'getcomplical-admin-key',
        description: 'API key for admin endpoints',
      });
      
      const adminUsagePlan = this.api.addUsagePlan('AdminUsagePlan', {
        name: 'Admin',
        description: 'Usage plan for admin endpoints',
        apiStages: [{
          api: this.api,
          stage: this.api.deploymentStage,
        }],
        throttle: {
          rateLimit: 10,
          burstLimit: 20,
        },
      });
      
      adminUsagePlan.addApiKey(adminApiKey);
    }

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'API Gateway URL',
    });

    new cdk.CfnOutput(this, 'DataLoaderFunctionName', {
      value: this.dataLoaderFunction.functionName,
      description: 'Data Loader Lambda function name',
    });
    
    if (props.billingWebhookFunction) {
      new cdk.CfnOutput(this, 'StripeWebhookUrl', {
        value: `${this.api.url}webhooks/stripe`,
        description: 'Webhook URL for Stripe',
      });
      
      new cdk.CfnOutput(this, 'PaddleWebhookUrl', {
        value: `${this.api.url}webhooks/paddle`,
        description: 'Webhook URL for Paddle',
      });
    }
  }
}