import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kinesis from 'aws-cdk-lib/aws-kinesisfirehose';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import { Construct } from 'constructs';
import * as path from 'path';

interface ApiComputeStackV2Props extends cdk.StackProps {
  userPool: cognito.UserPool;
  apiKeysTable: dynamodb.Table;
  taxDataTable: dynamodb.Table;
  rateLimitTable: dynamodb.Table;
  usageMetricsTable: dynamodb.Table;
  vpc: ec2.Vpc;
  redisEndpoint: string;
  firehoseStreamName: string;
  billingWebhookFunction?: lambda.Function;
  usageAggregatorFunction?: lambda.Function;
  usageMonitorFunction?: lambda.Function;
}

export class ApiComputeStackV2 extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public readonly authorizerFunction: NodejsFunction;
  public readonly apiHandlerFunction: NodejsFunction;
  public readonly dashboardFunction: NodejsFunction;
  public readonly dataLoaderFunction: NodejsFunction;
  public readonly healthFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiComputeStackV2Props) {
    super(scope, id, props);

    // Create Lambda layer for Valkey/Redis client
    const redisLayer = new lambda.LayerVersion(this, 'RedisLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../../layers/redis')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'Redis client (ioredis) for Lambda functions - works with Valkey',
    });

    // Create security group for Lambda functions
    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for Lambda functions accessing Valkey',
      allowAllOutbound: true,
    });

    // Create authorizer function with Valkey support
    this.authorizerFunction = new NodejsFunction(this, 'AuthorizerFunctionV2', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../lambdas/auth/authorizer-v2.ts'),
      environment: {
        API_KEYS_TABLE: props.apiKeysTable.tableName,
        REDIS_ENDPOINT: props.redisEndpoint,
        FIREHOSE_STREAM_NAME: props.firehoseStreamName,
      },
      timeout: cdk.Duration.seconds(3),
      memorySize: 512,
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      layers: [redisLayer],
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        minify: true,
        target: 'node20',
        sourceMap: true,
        externalModules: ['ioredis', '@aws-sdk/*'], // Provided by layer and runtime
      },
    });

    // Grant permissions
    props.apiKeysTable.grantReadData(this.authorizerFunction);

    // Create API handler function
    this.apiHandlerFunction = new NodejsFunction(this, 'ApiHandlerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../lambdas/api/handler.ts'),
      environment: {
        TAX_DATA_TABLE: props.taxDataTable.tableName,
        REGION: this.region,
        REDIS_ENDPOINT: props.redisEndpoint,
        FIREHOSE_STREAM_NAME: props.firehoseStreamName,
      },
      timeout: cdk.Duration.seconds(10),
      memorySize: 512,
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      layers: [redisLayer],
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        minify: true,
        target: 'node20',
        sourceMap: true,
        externalModules: ['ioredis', '@aws-sdk/*'],
      },
    });

    // Create dashboard function
    this.dashboardFunction = new NodejsFunction(this, 'DashboardFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../lambdas/api/dashboard.ts'),
      environment: {
        API_KEYS_TABLE: props.apiKeysTable.tableName,
        USAGE_METRICS_TABLE: props.usageMetricsTable.tableName,
        RATE_LIMIT_TABLE: props.rateLimitTable.tableName,
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

    // Create data loader function
    this.dataLoaderFunction = new NodejsFunction(this, 'DataLoaderFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../lambdas/data-loader/index.ts'),
      environment: {
        TAX_DATA_TABLE: props.taxDataTable.tableName,
      },
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      bundling: {
        minify: false,
        target: 'node20',
      },
    });

    // Create health check function
    this.healthFunction = new NodejsFunction(this, 'HealthFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../lambdas/api/health.ts'),
      environment: {
        API_KEYS_TABLE: props.apiKeysTable.tableName,
        TAX_DATA_TABLE: props.taxDataTable.tableName,
        RATE_LIMIT_TABLE: props.rateLimitTable.tableName,
        HEALTH_CHECK_KEY: 'will-be-set-by-secret',
        API_VERSION: '2.0.0',
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
    props.apiKeysTable.grantReadWriteData(this.dashboardFunction);
    props.taxDataTable.grantReadData(this.apiHandlerFunction);
    props.taxDataTable.grantWriteData(this.dataLoaderFunction);
    props.rateLimitTable.grantReadData(this.dashboardFunction);
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
    }));

    // Grant Kinesis Firehose permissions to both authorizer and API handler
    const firehoseArn = `arn:aws:firehose:${this.region}:${this.account}:deliverystream/${props.firehoseStreamName}`;
    
    this.authorizerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['firehose:PutRecord'],
      resources: [firehoseArn],
    }));
    
    this.apiHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['firehose:PutRecord'],
      resources: [firehoseArn],
    }));

    // Create REST API with caching enabled
    this.api = new apigateway.RestApi(this, 'GetComplicalApiV2', {
      restApiName: 'GetComplical Tax API v2',
      description: 'Tax calendar API for AU/NZ with Valkey caching',
      deployOptions: {
        stageName: 'v1',
        tracingEnabled: true,
        dataTraceEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
        throttlingBurstLimit: 100,
        throttlingRateLimit: 50,
        cachingEnabled: true,
        cacheClusterEnabled: true,
        cacheClusterSize: '0.5',
        cacheTtl: cdk.Duration.minutes(5),
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'X-Api-Key',
          'Authorization',
        ],
      },
      // CRITICAL: Make API private - only accessible via CloudFront
      // Use API key protection for now instead of resource policy
      policy: undefined,
    });

    // Create authorizer with caching
    const authorizer = new apigateway.TokenAuthorizer(this, 'ApiAuthorizerV2', {
      handler: this.authorizerFunction,
      identitySource: 'method.request.header.X-Api-Key',
      resultsCacheTtl: cdk.Duration.minutes(5), // Cache authorization results
    });

    // Create /api/v1 resource
    const apiResource = this.api.root.addResource('api');
    const v1Resource = apiResource.addResource('v1');

    // Add health check endpoint (no auth required)
    const healthResource = this.api.root.addResource('health');
    healthResource.addMethod('GET', new apigateway.LambdaIntegration(this.healthFunction), {
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
      ],
    });

    // Add tax-dates endpoint with caching
    const taxDatesResource = v1Resource.addResource('tax-dates');
    taxDatesResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(this.apiHandlerFunction),
      {
        authorizer,
        methodResponses: [
          {
            statusCode: '200',
            responseModels: {
              'application/json': apigateway.Model.EMPTY_MODEL,
            },
          },
        ],
        requestParameters: {
          'method.request.header.X-Api-Key': false,
          'method.request.querystring.country': false,
          'method.request.querystring.year': false,
          'method.request.querystring.type': false,
          'method.request.querystring.state': false,
          'method.request.querystring.agency': false,
          'method.request.querystring.frequency': false,
        },
      }
    );

    // Enable caching on the tax-dates method
    const taxDatesMethod = taxDatesResource.node.findChild('GET') as apigateway.Method;
    if (taxDatesMethod) {
      const methodResource = taxDatesMethod.node.defaultChild as apigateway.CfnMethod;
      methodResource.addPropertyOverride('Integration.CacheKeyParameters', [
        'method.request.header.X-Api-Key',
        'method.request.querystring.country',
        'method.request.querystring.year',
        'method.request.querystring.type',
        'method.request.querystring.state',
        'method.request.querystring.agency',
        'method.request.querystring.frequency',
      ]);
      methodResource.addPropertyOverride('Integration.CacheNamespace', 'tax-dates');
    }

    // Add Cognito authorizer for dashboard
    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [props.userPool],
      identitySource: 'method.request.header.Authorization',
    });

    // Add dashboard endpoints
    const dashboardResource = this.api.root.addResource('dashboard');
    
    // GET /dashboard/keys
    const keysResource = dashboardResource.addResource('keys');
    keysResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(this.dashboardFunction),
      {
        authorizer: cognitoAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      }
    );

    // Add other dashboard endpoints...
    const usageResource = dashboardResource.addResource('usage');
    const monthlyResource = usageResource.addResource('monthly');
    monthlyResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(this.dashboardFunction),
      {
        authorizer: cognitoAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      }
    );

    // Add webhook endpoints (if provided)
    if (props.billingWebhookFunction) {
      const webhooksResource = this.api.root.addResource('webhooks');
      const stripeResource = webhooksResource.addResource('stripe');
      stripeResource.addMethod('POST', new apigateway.LambdaIntegration(props.billingWebhookFunction));
      
      const paddleResource = webhooksResource.addResource('paddle');
      paddleResource.addMethod('POST', new apigateway.LambdaIntegration(props.billingWebhookFunction));
    }

    // Output the API URL
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'GetComplical API URL (v2 with Valkey)',
    });

    new cdk.CfnOutput(this, 'ApiId', {
      value: this.api.restApiId,
      description: 'API Gateway ID',
    });
  }
}