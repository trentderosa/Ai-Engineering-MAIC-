import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';

export class MaicChatbotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB table for guest usage tracking
    const usageTable = new dynamodb.Table(this, 'UsageTable', {
      tableName: 'maic-chat-usage',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Cognito User Pool for MAIC members
    const userPool = new cognito.UserPool(this, 'MaicUserPool', {
      userPoolName: 'maic-members',
      selfSignUpEnabled: false, // Admin invites only
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'MaicUserPoolClient', {
      userPool,
      userPoolClientName: 'maic-chatbot-client',
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false, // Browser client - no secret
    });

    // Lambda function for chat
    const chatLambda = new lambda.Function(this, 'ChatFunction', {
      functionName: 'maic-chat-handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'chat.handler',
      code: lambda.Code.fromAsset('lambda'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        USAGE_TABLE: usageTable.tableName,
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
      },
    });

    // Grant Lambda permissions
    usageTable.grantReadWriteData(chatLambda);
    chatLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-haiku-20241022-v1:0',
        'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-haiku-20241022-v1:0',
        'arn:aws:bedrock:us-east-1:928622535528:inference-profile/us.anthropic.claude-3-5-haiku-20241022-v1:0',
      ],
    }));

    // API Gateway
    const api = new apigateway.RestApi(this, 'ChatApi', {
      restApiName: 'maic-chatbot-api',
      description: 'MAIC AI Chatbot API',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const chatResource = api.root.addResource('chat');
    chatResource.addMethod('POST', new apigateway.LambdaIntegration(chatLambda));

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url + 'chat',
      description: 'Chat API endpoint URL',
      exportName: 'MaicChatApiUrl',
    });
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
      exportName: 'MaicUserPoolId',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
      exportName: 'MaicUserPoolClientId',
    });
  }
}
