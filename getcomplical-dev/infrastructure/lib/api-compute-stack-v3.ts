import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';

export class ApiComputeStackV3 extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public readonly authorizerFunction: NodejsFunction;
  public readonly apiHandlerFunction: NodejsFunction;
  public readonly dashboardFunction: NodejsFunction;
  public readonly dataLoaderFunction: NodejsFunction;
  public readonly healthFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Look up resources from SSM Parameters
    const redisEndpoint = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/infrastructure/redis/endpoint'
    );
    
    const firehoseStreamName = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/infrastructure/kinesis/firehose-stream-name'
    );

    // Look up table names
    const apiKeysTableName = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/tables/api-keys/name'
    );
    
    const taxDataTableName = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/tables/tax-data/name'
    );
    
    const rateLimitTableName = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/tables/rate-limit/name'
    );
    
    const usageMetricsTableName = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/tables/usage-metrics/name'
    );

    // Look up secret ARNs
    const valkeyAuthTokenArn = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/secrets/valkey-auth/arn'
    );

    // For VPC, we need to use a different approach since fromLookup requires concrete values
    // Import VPC by attributes instead
    const vpcId = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/infrastructure/vpc/id'
    );
    
    // Get availability zones from context (will be populated during synth)
    const availabilityZones = ['ap-south-1a', 'ap-south-1b']; // Mumbai AZs
    
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId,
      availabilityZones,
    });
    
    const apiKeysTable = dynamodb.Table.fromTableName(
      this, 'ApiKeysTable', apiKeysTableName
    );
    
    const taxDataTable = dynamodb.Table.fromTableName(
      this, 'TaxDataTable', taxDataTableName
    );
    
    const rateLimitTable = dynamodb.Table.fromTableName(
      this, 'RateLimitTable', rateLimitTableName
    );
    
    const usageMetricsTable = dynamodb.Table.fromTableName(
      this, 'UsageMetricsTable', usageMetricsTableName
    );

    // Look up user pool - need to get the ARN from SSM
    const userPoolArn = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/auth/user-pool/arn'
    );
    
    const userPool = cognito.UserPool.fromUserPoolArn(
      this, 'UserPool', userPoolArn
    );

    // Create Lambda layer for Valkey/Redis client
    const redisLayer = new lambda.LayerVersion(this, 'RedisLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../../layers/redis')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'Redis client (ioredis) for Lambda functions - works with Valkey',
    });

    // Create security group for Lambda functions
    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc,
      description: 'Security group for Lambda functions accessing Valkey',
      allowAllOutbound: true,
    });

    // Get private subnets
    const privateSubnetIds = [
      ssm.StringParameter.valueForStringParameter(this, '/getcomplical/infrastructure/vpc/private-subnet-0'),
      ssm.StringParameter.valueForStringParameter(this, '/getcomplical/infrastructure/vpc/private-subnet-1'),
    ];

    const privateSubnets = privateSubnetIds.map((subnetId, index) => 
      ec2.Subnet.fromSubnetId(this, `PrivateSubnet${index}`, subnetId)
    );

    // Create authorizer function with Valkey support
    this.authorizerFunction = new NodejsFunction(this, 'AuthorizerFunctionV3', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../lambdas/auth/authorizer-v2.ts'),
      environment: {
        API_KEYS_TABLE: apiKeysTableName,
        REDIS_ENDPOINT: redisEndpoint,
        REDIS_TLS_ENABLED: 'false',
        VALKEY_AUTH_TOKEN_ARN: valkeyAuthTokenArn,
        FIREHOSE_STREAM_NAME: firehoseStreamName,
      },
      timeout: cdk.Duration.seconds(3),
      memorySize: 512,
      vpc,
      vpcSubnets: { subnets: privateSubnets },
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

    // Grant permissions
    apiKeysTable.grantReadData(this.authorizerFunction);
    
    // Grant access to Valkey auth token
    this.authorizerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [valkeyAuthTokenArn],
    }));

    // Create API handler function
    this.apiHandlerFunction = new NodejsFunction(this, 'ApiHandlerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../lambdas/api/handler.ts'),
      environment: {
        TAX_DATA_TABLE: taxDataTableName,
        REGION: this.region,
        REDIS_ENDPOINT: redisEndpoint,
        REDIS_TLS_ENABLED: 'false',
        VALKEY_AUTH_TOKEN_ARN: valkeyAuthTokenArn,
        FIREHOSE_STREAM_NAME: firehoseStreamName,
      },
      timeout: cdk.Duration.seconds(10),
      memorySize: 512,
      vpc,
      vpcSubnets: { subnets: privateSubnets },
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
        API_KEYS_TABLE: apiKeysTableName,
        USAGE_METRICS_TABLE: usageMetricsTableName,
        RATE_LIMIT_TABLE: rateLimitTableName,
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
        TAX_DATA_TABLE: taxDataTableName,
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
        API_KEYS_TABLE: apiKeysTableName,
        TAX_DATA_TABLE: taxDataTableName,
        RATE_LIMIT_TABLE: rateLimitTableName,
        HEALTH_CHECK_KEY: 'will-be-set-by-secret',
        API_VERSION: '3.0.0',
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
    apiKeysTable.grantReadWriteData(this.dashboardFunction);
    taxDataTable.grantReadData(this.apiHandlerFunction);
    taxDataTable.grantWriteData(this.dataLoaderFunction);
    rateLimitTable.grantReadData(this.dashboardFunction);
    usageMetricsTable.grantReadData(this.dashboardFunction);
    
    // Grant Valkey auth token access to API handler
    this.apiHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [valkeyAuthTokenArn],
    }));
    
    // Grant permissions for health check function
    apiKeysTable.grantReadData(this.healthFunction);
    taxDataTable.grantReadData(this.healthFunction);
    rateLimitTable.grantReadData(this.healthFunction);
    
    // Grant CloudWatch permissions for health check
    this.healthFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricStatistics'],
      resources: ['*'],
    }));
    
    // Grant access to health check secret
    const healthCheckSecretArn = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/secrets/health-check-key/arn'
    );
    
    const healthCheckSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this, 'HealthCheckSecret', healthCheckSecretArn
    );
    
    healthCheckSecret.grantRead(this.healthFunction);
    this.healthFunction.addEnvironment('HEALTH_CHECK_SECRET_ARN', healthCheckSecretArn);

    // Grant CloudWatch permissions for metrics
    this.apiHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    // Grant Kinesis Firehose permissions
    const firehoseArn = `arn:aws:firehose:${this.region}:${this.account}:deliverystream/${firehoseStreamName}`;
    
    this.authorizerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['firehose:PutRecord'],
      resources: [firehoseArn],
    }));
    
    this.apiHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['firehose:PutRecord'],
      resources: [firehoseArn],
    }));

    // Create REST API
    this.api = new apigateway.RestApi(this, 'GetComplicalApiV3', {
      restApiName: 'GetComplical Tax API v3',
      description: 'Tax calendar API for AU/NZ - Independent stack version',
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
          'X-CloudFront-Secret',
        ],
      },
    });

    // Create authorizer
    const authorizer = new apigateway.TokenAuthorizer(this, 'ApiAuthorizerV3', {
      handler: this.authorizerFunction,
      identitySource: 'method.request.header.X-Api-Key',
      resultsCacheTtl: cdk.Duration.minutes(5),
    });

    // Create /api/v1 resource
    const apiResource = this.api.root.addResource('api');
    const v1Resource = apiResource.addResource('v1');

    // Add health check endpoint
    const healthResource = this.api.root.addResource('health');
    healthResource.addMethod('GET', new apigateway.LambdaIntegration(this.healthFunction));

    // Add tax-dates endpoint
    const taxDatesResource = v1Resource.addResource('tax-dates');
    taxDatesResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(this.apiHandlerFunction),
      {
        authorizer,
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
      cognitoUserPools: [userPool],
      identitySource: 'method.request.header.Authorization',
    });

    // Add dashboard endpoints
    const dashboardResource = this.api.root.addResource('dashboard');
    const keysResource = dashboardResource.addResource('keys');
    keysResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(this.dashboardFunction),
      {
        authorizer: cognitoAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      }
    );

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

    // Export Lambda function ARNs to SSM for monitoring
    new ssm.StringParameter(this, 'AuthorizerFunctionArnParam', {
      parameterName: '/getcomplical/functions/authorizer/arn',
      stringValue: this.authorizerFunction.functionArn,
      description: 'ARN of the authorizer Lambda function',
    });

    new ssm.StringParameter(this, 'ApiHandlerFunctionArnParam', {
      parameterName: '/getcomplical/functions/api-handler/arn',
      stringValue: this.apiHandlerFunction.functionArn,
      description: 'ARN of the API handler Lambda function',
    });

    new ssm.StringParameter(this, 'DashboardFunctionArnParam', {
      parameterName: '/getcomplical/functions/dashboard/arn',
      stringValue: this.dashboardFunction.functionArn,
      description: 'ARN of the dashboard Lambda function',
    });

    new ssm.StringParameter(this, 'HealthFunctionArnParam', {
      parameterName: '/getcomplical/functions/health/arn',
      stringValue: this.healthFunction.functionArn,
      description: 'ARN of the health check Lambda function',
    });

    // Export API Gateway info
    new ssm.StringParameter(this, 'ApiGatewayIdParam', {
      parameterName: '/getcomplical/api/gateway-id',
      stringValue: this.api.restApiId,
      description: 'API Gateway REST API ID',
    });

    new ssm.StringParameter(this, 'ApiGatewayArnParam', {
      parameterName: '/getcomplical/api/gateway-arn',
      stringValue: this.api.arnForExecuteApi(),
      description: 'API Gateway execution ARN',
    });

    // Output the API URL
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'GetComplical API URL (v3 - Independent)',
    });

    new cdk.CfnOutput(this, 'ApiId', {
      value: this.api.restApiId,
      description: 'API Gateway ID',
    });
  }
}