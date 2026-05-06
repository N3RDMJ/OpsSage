import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { DatadogIpRanges } from './datadog-ip-ranges';
import type { SecretEntries } from './secrets-stack';

export interface EcsStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  cloudMapNamespace: servicediscovery.IPrivateDnsNamespace;
  secrets: SecretEntries;
  certificateArn?: string;
  alertChannel: string;
}

/**
 * One Fargate service: the agent. flue manages its own sandbox connector
 * (default: virtual just-bash inside the agent task), so v1 ships without a
 * sibling sandbox service. We can switch to flue's Daytona connector later by
 * setting the relevant env vars without changing this stack's shape.
 */
export class EcsStack extends cdk.Stack {
  readonly agentLogGroupName: string;

  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    const { vpc, cloudMapNamespace, secrets } = props;

    const agentRepo = new ecr.Repository(this, 'AgentRepo', {
      repositoryName: 'opssage/agent',
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 20 }],
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      enableFargateCapacityProviders: true,
      defaultCloudMapNamespace: {
        name: cloudMapNamespace.namespaceName,
        useForServiceConnect: true,
      },
    });

    const agentLogs = new logs.LogGroup(this, 'AgentLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
    });
    this.agentLogGroupName = agentLogs.logGroupName;

    const agentTaskDef = new ecs.FargateTaskDefinition(this, 'AgentTask', {
      cpu: 1024,
      memoryLimitMiB: 2048,
    });
    agentTaskDef.addContainer('agent', {
      image: ecs.ContainerImage.fromEcrRepository(agentRepo, 'latest'),
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'agent', logGroup: agentLogs }),
      portMappings: [{ containerPort: 8080, name: 'http' }],
      secrets: {
        OPSSAGE_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(
          secrets.webhook,
          'datadog_shared_secret',
        ),
        DATADOG_API_KEY: ecs.Secret.fromSecretsManager(secrets.datadog, 'api_key'),
        DATADOG_APP_KEY: ecs.Secret.fromSecretsManager(secrets.datadog, 'app_key'),
        DATADOG_SITE: ecs.Secret.fromSecretsManager(secrets.datadog, 'site'),
        GITHUB_TOKEN: ecs.Secret.fromSecretsManager(secrets.github, 'pat'),
        SLACK_BOT_TOKEN: ecs.Secret.fromSecretsManager(secrets.slack, 'bot_token'),
        SLACK_SIGNING_SECRET: ecs.Secret.fromSecretsManager(secrets.slack, 'signing_secret'),
        CURSOR_API_KEY: ecs.Secret.fromSecretsManager(secrets.cursor, 'api_key'),
        LANGFUSE_PUBLIC_KEY: ecs.Secret.fromSecretsManager(secrets.langfuse, 'public_key'),
        LANGFUSE_SECRET_KEY: ecs.Secret.fromSecretsManager(secrets.langfuse, 'secret_key'),
        LANGFUSE_HOST: ecs.Secret.fromSecretsManager(secrets.langfuse, 'host'),
      },
      environment: {
        NODE_ENV: 'production',
        PORT: '8080',
        PROVIDER: 'cursor',
        FLUE_MODEL: 'anthropic/claude-sonnet-4-6',
        OPSSAGE_ALERT_CHANNEL: props.alertChannel,
        OPSSAGE_REPOS_FILE: '/app/config/repos.yaml',
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:8080/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    const agentSg = new ec2.SecurityGroup(this, 'AgentSg', {
      vpc,
      description: 'OpsSage agent',
      allowAllOutbound: true,
    });

    const agentService = new ecs.FargateService(this, 'AgentService', {
      cluster,
      taskDefinition: agentTaskDef,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [agentSg],
    });

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'OpsSage ALB ingress (Datadog-only)',
      allowAllOutbound: true,
    });
    agentSg.addIngressRule(albSg, ec2.Port.tcp(8080), 'ALB → agent');

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    if (props.certificateArn) {
      const cert = acm.Certificate.fromCertificateArn(this, 'AlbCert', props.certificateArn);
      const httpsListener = alb.addListener('Https', {
        port: 443,
        certificates: [cert],
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      });
      httpsListener.addTargets('Agent', {
        port: 8080,
        targets: [agentService],
        healthCheck: { path: '/health', healthyHttpCodes: '200' },
      });
    } else {
      const httpListener = alb.addListener('Http', { port: 80 });
      httpListener.addTargets('Agent', {
        port: 8080,
        targets: [agentService],
        healthCheck: { path: '/health', healthyHttpCodes: '200' },
      });
    }

    new DatadogIpRanges(this, 'DdIpSync', {
      securityGroup: albSg,
      port: props.certificateArn ? 443 : 80,
    });

    new cdk.CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'AgentRepoUri', { value: agentRepo.repositoryUri });
  }
}
