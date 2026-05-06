import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

export interface ObservabilityStackProps extends cdk.StackProps {
  agentLogGroupName: string;
}

export class ObservabilityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const agentLogs = logs.LogGroup.fromLogGroupName(this, 'AgentLogs', props.agentLogGroupName);

    // 5xx on the webhook endpoint → metric.
    const fiveXx = new logs.MetricFilter(this, 'WebhookFiveXx', {
      logGroup: agentLogs,
      metricNamespace: 'OpsSage',
      metricName: 'WebhookFiveXx',
      metricValue: '1',
      filterPattern: logs.FilterPattern.literal('{ $.level = "error" && $.msg = "fatal" }'),
    });

    // Schema-validation rejections → metric.
    const parseFails = new logs.MetricFilter(this, 'WebhookParseFails', {
      logGroup: agentLogs,
      metricNamespace: 'OpsSage',
      metricName: 'WebhookParseFails',
      metricValue: '1',
      filterPattern: logs.FilterPattern.literal(
        '{ $.msg = "datadog webhook rejected: schema" || $.msg = "datadog webhook rejected: bad secret" }',
      ),
    });

    new cloudwatch.Alarm(this, 'WebhookFiveXxAlarm', {
      metric: fiveXx.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'OpsSage agent emitted a fatal log line.',
    });

    new cloudwatch.Alarm(this, 'WebhookParseFailsAlarm', {
      metric: parseFails.metric({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'OpsSage rejected ≥5 webhooks in 15 min — check Datadog config or rotate the shared secret.',
    });
  }
}
