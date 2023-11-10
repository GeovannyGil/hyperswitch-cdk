import * as cdk from "aws-cdk-lib";
import { Duration, RemovalPolicy, SecretValue } from "aws-cdk-lib";
import {
  ISecurityGroup,
  InstanceType,
  Port,
  SecurityGroup,
  Vpc,
  SubnetType
} from "aws-cdk-lib/aws-ec2";
import {
  AuroraPostgresEngineVersion,
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
} from "aws-cdk-lib/aws-rds";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { RDSConfig } from "./config";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Function, Code, Runtime } from "aws-cdk-lib/aws-lambda";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import * as triggers from "aws-cdk-lib/triggers";

export class DataBaseConstruct {
  sg: SecurityGroup;
  db_cluster: DatabaseCluster;
  password: string;
  bucket: cdk.aws_s3.Bucket;

  constructor(scope: Construct, rds_config: RDSConfig, vpc: Vpc) {
    const engine = DatabaseClusterEngine.auroraPostgres({
      version: AuroraPostgresEngineVersion.VER_13_7,
    });

    const db_name = "hyperswitch";

    const db_security_group = new SecurityGroup(scope, "Hyperswitch-db-SG", {
      securityGroupName: "Hyperswitch-db-SG",
      vpc: vpc,
    });

    this.sg = db_security_group;

    const secretName = "hypers-db-master-user-secret";

    // Create the secret if it doesn't exist
    let secret = new Secret(scope, "hypers-db-master-user-secret", {
      secretName: secretName,
      description: "Database master user credentials",
      secretObjectValue: {
        dbname: SecretValue.unsafePlainText(db_name),
        username: SecretValue.unsafePlainText(rds_config.db_user),
        password: SecretValue.unsafePlainText(rds_config.password),
      },
    });

    // const uploadSchemaAndMigrationCode = `import boto3
    // import urllib3

    // def upload_file_from_url(url, bucket, key):
    //     s3=boto3.client('s3')
    //     http=urllib3.PoolManager()
    //     s3.upload_fileobj(http.request('GET', url,preload_content=False), bucket, key)
    //     s3.upload_fileobj

    // def lambda_handler(event, context):
    //     try:
    //         upload_file_from_url("https://hyperswitch-bucket.s3.amazonaws.com/migration_runner.zip", "hyperswitch-${process.env.CDK_DEFAULT_REGION}-${cdk.Aws.ACCOUNT_ID}", "migration_runner.zip")
    //         upload_file_from_url("https://hyperswitch-bucket.s3.amazonaws.com/schema.sql", "hyperswitch-${process.env.CDK_DEFAULT_REGION}-${cdk.Aws.ACCOUNT_ID}", "schema.sql")
    //     except e:
    //         return e
    //     return '{ status= 200, message = "success"}'`

    // const lambdaRoleSchemaUpload = new Role(scope, "uploadlambdarole", {
    //   assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    // });

    // lambdaRoleSchemaUpload.addToPolicy(
    //   new PolicyStatement({
    //     actions: [
    //       "*"
    //     ],
    //     resources: ["*", "*"],
    //   })
    // );

    // const initializeUploadFunction = new Function(scope, "initializeUploadFunction", {
    //   runtime: Runtime.PYTHON_3_9,
    //   handler: "index.db_handler",
    //   code: Code.fromInline(uploadSchemaAndMigrationCode),
    //   vpc: vpc,
    //   timeout: Duration.minutes(15),
    //   role: lambdaRoleSchemaUpload,
    // });


    this.password = rds_config.password;
    const db_cluster = new DatabaseCluster(scope, "hyperswitch-db-cluster", {
      writer: ClusterInstance.provisioned("Writer Instance", {
        instanceType: InstanceType.of(
          rds_config.writer_instance_class,
          rds_config.writer_instance_size
        ),
        publiclyAccessible: true,
      }),
      // readers: [
      //   ClusterInstance.provisioned("Reader Instance", {
      //     instanceType: InstanceType.of(
      //       rds_config.reader_instance_class,
      //       rds_config.reader_instance_size
      //     ),
      //   }),
      // ],
      vpc,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      engine,
      port: rds_config.port,
      securityGroups: [db_security_group],
      defaultDatabaseName: db_name,
      credentials: Credentials.fromSecret(secret),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Add ingress rule to allow traffic from any IP address
    db_cluster.connections.allowFromAnyIpv4(Port.tcp(rds_config.port));

    this.db_cluster = db_cluster;


    const schemaBucket = Bucket.fromBucketName(scope, "hsbucket", "hyperswitch-bucket");

    // let schemaBucket = new Bucket(scope, "SchemaBucket", {
    //   removalPolicy: RemovalPolicy.DESTROY,
    //   autoDeleteObjects: true,
    //   bucketName:
    //     "hyperswitch-schema-" +
    //     cdk.Aws.ACCOUNT_ID +
    //     "-" +
    //     process.env.CDK_DEFAULT_REGION,
    // });

    // const bucketDeployment = new BucketDeployment(
    //   scope,
    //   "DeploySchemaToBucket",
    //   {
    //     sources: [Source.asset("./dependencies/schema")],
    //     destinationBucket: schemaBucket,
    //     retainOnDelete: false,
    //   }
    // );

    const lambdaRole = new Role(scope, "RDSLambdaRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });

    // schemaBucket.grantRead(lambdaRole, "schema.sql");

    lambdaRole.addToPolicy(
      new PolicyStatement({
        actions: [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
          "ec2:AttachNetworkInterface",
          "ec2:DetachNetworkInterface",
          "secretsmanager:GetSecretValue",
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "s3:GetObject",
        ],
        resources: ["*", schemaBucket.bucketArn + "/*"],
      })
    );

    const lambdaSecurityGroup = new SecurityGroup(
      scope,
      "LambdaSecurityGroup",
      {
        vpc,
        allowAllOutbound: true,
      }
    );

    db_security_group.addIngressRule(
      lambdaSecurityGroup,
      Port.tcp(rds_config.port)
    );

    const initializeDBFunction = new Function(scope, "InitializeDBFunction", {
      runtime: Runtime.PYTHON_3_9,
      handler: "index.db_handler",
      code: Code.fromBucket(schemaBucket, "migration_runner.zip"),
      // code: Code.fromAsset(
      //   "./dependencies/migration_runner/migration_runner.zip"
      // ),
      environment: {
        DB_SECRET_ARN: secret.secretArn,
        SCHEMA_BUCKET: schemaBucket.bucketName,
        SCHEMA_FILE_KEY: "schema.sql",
      },
      vpc: vpc,
      securityGroups: [lambdaSecurityGroup],
      timeout: Duration.minutes(15),
      role: lambdaRole,
    });

    // new triggers.Trigger(scope, "initializeUploadTrigger", {
    //   handler: initializeUploadFunction,
    //   timeout: Duration.minutes(15),
    //   invocationType: triggers.InvocationType.EVENT,
    // }).executeBefore();

    new triggers.Trigger(scope, "InitializeDBTrigger", {
      handler: initializeDBFunction,
      timeout: Duration.minutes(15),
      invocationType: triggers.InvocationType.EVENT,
    }).executeAfter(db_cluster);

  }

  addClient(
    peer: ISecurityGroup,
    port: number,
    description?: string,
    remote_rule?: boolean
  ) {
    this.sg.addIngressRule(peer, Port.tcp(port), description, remote_rule);
    peer.addEgressRule(this.sg, Port.tcp(port), description, remote_rule);
  }
}