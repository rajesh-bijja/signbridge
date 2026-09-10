import React, { useState } from "react";
import {
  Alert,
  Autosuggest,
  Box,
  Button,
  ColumnLayout,
  FormField,
  Input,
  Select,
  SpaceBetween
} from "@cloudscape-design/components";
import * as presignApi from "../presignApi";
import AuthorizeRetryAlert from "../AuthorizeRetryAlert";
import { describeError } from "../../utils/awsRequestUtils";

// The IRSA (EKS service account) sub-form.
//
// An IRSA role is assumed by a *Kubernetes* identity, so there is no static
// credential to type in: SignBridge mints a service-account token on the cluster
// and exchanges it for STS credentials. The form therefore walks the same path
// the manual recipe does — base AWS profile, region, cluster, service account —
// except that each step is discovered instead of typed, and none of it needs
// kubectl, jq or a kubeconfig on this host.
//
// Two things worth knowing when editing this file:
//
//   * The base profile is not the identity being used. It only provides the
//     eks:DescribeCluster / iam:GetRole calls and the cluster bearer token; the
//     credentials the profile ultimately signs with come from
//     sts:AssumeRoleWithWebIdentity, i.e. the IRSA role itself. Saying so on
//     screen matters, because otherwise "which profile am I actually using?" is
//     genuinely ambiguous.
//   * Discovery is explicit (a button per step), not automatic. Each step is a
//     real AWS/Kubernetes API call, and firing them off a keystroke would mean
//     hitting a cluster while someone is still typing its region.

// Regions where EKS is commonly used. The field is an Autosuggest, not a Select,
// so any region can still be typed — this list is a shortcut, not a constraint.
const COMMON_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-north-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "sa-east-1"
];

export const DEFAULT_IRSA_REGION = "us-east-1";

export const EMPTY_IRSA = {
  baseProfileName: "",
  baseAuthnMode: "",
  region: DEFAULT_IRSA_REGION,
  clusterName: "",
  namespace: "",
  serviceAccount: "",
  roleArn: "",
  audience: ""
};

export function irsaFromProfile(profile) {
  if (!profile) {
    return { ...EMPTY_IRSA };
  }
  return {
    baseProfileName: profile.irsaBaseProfileName || "",
    baseAuthnMode: profile.irsaBaseAuthnMode || "",
    region: profile.irsaRegion || DEFAULT_IRSA_REGION,
    clusterName: profile.irsaClusterName || "",
    namespace: profile.irsaNamespace || "",
    serviceAccount: profile.irsaServiceAccount || "",
    roleArn: profile.irsaRoleArn || "",
    audience: profile.irsaAudience || ""
  };
}

export function irsaToProfile(value) {
  const v = value || EMPTY_IRSA;
  const profile = {
    irsaBaseProfileName: (v.baseProfileName || "").trim(),
    irsaRegion: (v.region || "").trim() || DEFAULT_IRSA_REGION,
    irsaClusterName: (v.clusterName || "").trim(),
    irsaNamespace: (v.namespace || "").trim(),
    irsaServiceAccount: (v.serviceAccount || "").trim(),
    irsaRoleArn: (v.roleArn || "").trim()
  };
  if (v.baseAuthnMode) {
    profile.irsaBaseAuthnMode = v.baseAuthnMode;
  }
  // Blank means "whatever the trust policy requires", which the backend resolves
  // per call. Persisting an empty string would look like an explicit choice.
  if ((v.audience || "").trim()) {
    profile.irsaAudience = v.audience.trim();
  }
  return profile;
}

const AWS_MODE_LABELS = {
  sso_user: "AWS SSO / IAM Identity Center",
  iam_user: "AWS IAM User"
};

// The base profile has to be one that yields AWS credentials on its own, which
// rules out EC2 (its credentials come from a box that may be unreachable) and
// IRSA (that would be circular).
function baseModesFor(profile) {
  const supported = Array.isArray(profile?.supportedAuthnMechanisms)
    ? profile.supportedAuthnMechanisms
    : [];
  return ["sso_user", "iam_user"].filter((mode) => supported.indexOf(mode) >= 0);
}

function IrsaProfileForm({ value, onChange, profileName, profiles }) {
  const v = value || EMPTY_IRSA;
  const set = (patch) => onChange({ ...v, ...patch });

  const [clusters, setClusters] = useState([]);
  const [loadingClusters, setLoadingClusters] = useState(false);
  const [serviceAccounts, setServiceAccounts] = useState([]);
  const [loadingServiceAccounts, setLoadingServiceAccounts] = useState(false);
  const [roleFacts, setRoleFacts] = useState(null);
  const [loadingRole, setLoadingRole] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [error, setError] = useState(null);
  // Each discovery step is a real API call, so "did that work?" needs answering
  // out loud — a Select that quietly gains options looks identical to one that
  // silently found nothing.
  const [notice, setNotice] = useState(null);
  // The closure that re-runs whatever failed. An expired SSO session is the
  // commonest failure here and the fix happens in another tab, so the user must
  // be able to come back and continue rather than re-fill the form.
  const [retry, setRetry] = useState(null);

  const candidateProfiles = (profiles || []).filter((p) => baseModesFor(p).length > 0);
  const selectedBase = candidateProfiles.find((p) => p.profileName === v.baseProfileName) || null;
  const baseModes = baseModesFor(selectedBase);

  const fail = (err, fallback, retryFn) => {
    setError(describeError(err, fallback));
    setRetry(retryFn ? () => retryFn : null);
  };
  const startStep = () => {
    setError(null);
    setRetry(null);
    setNotice(null);
  };

  const handleLoadClusters = async () => {
    startStep();
    setLoadingClusters(true);
    setClusters([]);
    const region = v.region || DEFAULT_IRSA_REGION;
    try {
      const result = await presignApi.listIrsaClusters(
        v.baseProfileName,
        v.baseAuthnMode || undefined,
        region
      );
      const found = (result && result.clusters) || [];
      setClusters(found);
      if (!found.length) {
        setError(
          describeError(
            null,
            `No EKS clusters found in ${region} for profile "${v.baseProfileName}". Check the region, or that the profile can call eks:ListClusters.`
          )
        );
        setRetry(() => handleLoadClusters);
      } else {
        setNotice({
          header: `Loaded ${found.length} ${found.length === 1 ? "cluster" : "clusters"} from ${region}`,
          text:
            found.length === 1
              ? `Selected "${found[0]}" — now load its service accounts.`
              : "Choose one in the dropdown, then load its service accounts."
        });
        // One cluster is not a choice; picking it saves a click and makes the
        // next button usable immediately.
        if (found.length === 1 && !v.clusterName) {
          set({ clusterName: found[0] });
        }
      }
    } catch (err) {
      fail(err, "Could not list EKS clusters.", handleLoadClusters);
    } finally {
      setLoadingClusters(false);
    }
  };

  const handleLoadServiceAccounts = async () => {
    startStep();
    setLoadingServiceAccounts(true);
    setServiceAccounts([]);
    try {
      const result = await presignApi.listIrsaServiceAccounts(
        v.baseProfileName,
        v.baseAuthnMode || undefined,
        v.region || DEFAULT_IRSA_REGION,
        v.clusterName
      );
      const found = (result && result.serviceAccounts) || [];
      setServiceAccounts(found);
      if (!found.length) {
        setError(
          describeError(
            null,
            `No service accounts on "${v.clusterName}" carry an eks.amazonaws.com/role-arn annotation. Enter the namespace, service account and role ARN below if you know them.`
          )
        );
        setRetry(() => handleLoadServiceAccounts);
      } else {
        const namespaces = new Set(found.map((sa) => sa.namespace));
        setNotice({
          header: `Found ${found.length} IRSA service ${found.length === 1 ? "account" : "accounts"} on "${v.clusterName}"`,
          text: `Across ${namespaces.size} ${namespaces.size === 1 ? "namespace" : "namespaces"}. Choose one — its namespace, name and role ARN fill in below, and the role's trust policy is checked for you.`
        });
      }
    } catch (err) {
      fail(err, "Could not list service accounts on the cluster.", handleLoadServiceAccounts);
    } finally {
      setLoadingServiceAccounts(false);
    }
  };

  // Reading the trust policy is what turns "AccessDenied" into "this role trusts
  // a different service account". It needs iam:GetRole, which is often not
  // granted, so an unreadable policy is reported and never blocks the save.
  const inspectRole = async (roleArn, namespace, serviceAccount) => {
    if (!roleArn || !v.baseProfileName) {
      return;
    }
    setLoadingRole(true);
    setRoleFacts(null);
    setError(null);
    setRetry(null);
    try {
      const result = await presignApi.describeIrsaRole(
        v.baseProfileName,
        v.baseAuthnMode || undefined,
        roleArn,
        namespace,
        serviceAccount
      );
      setRoleFacts(result || null);
    } catch (err) {
      fail(err, "Could not read the role's trust policy.", () =>
        inspectRole(roleArn, namespace, serviceAccount)
      );
    } finally {
      setLoadingRole(false);
    }
  };

  const handlePickServiceAccount = (option) => {
    const sa = serviceAccounts.find(
      (item) => `${item.namespace}/${item.name}` === option.value
    );
    if (!sa) {
      return;
    }
    set({ namespace: sa.namespace, serviceAccount: sa.name, roleArn: sa.roleArn });
    inspectRole(sa.roleArn, sa.namespace, sa.name);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    startStep();
    try {
      const result = await presignApi.testIrsaConnection(profileName || null, {
        profileName: profileName || undefined,
        irsaEnabled: true,
        ...irsaToProfile(v)
      });
      if (result && result.success) {
        setTestResult(result);
      } else {
        // A failure body carries the same { message, verificationUriComplete }
        // shape as a rejection, so it takes the same path — including the link.
        fail(result, "The IRSA credential test failed.", handleTest);
      }
    } catch (err) {
      fail(err, "The IRSA credential test failed.", handleTest);
    } finally {
      setTesting(false);
    }
  };

  const subjectCheck = roleFacts && roleFacts.subjectCheck;

  return (
    <SpaceBetween size="s">
      <Box variant="small" color="text-body-secondary">
        The base profile below is used only to reach the cluster and read the role.
        Requests made with this profile are signed with credentials from{" "}
        <code>sts:AssumeRoleWithWebIdentity</code> — i.e. the IRSA role itself.
        <b> kubectl is not required.</b>
      </Box>

      <ColumnLayout columns={2}>
        <FormField
          label="Base AWS profile *"
          description="An IAM User or SSO profile that can call eks:DescribeCluster."
        >
          <Select
            selectedOption={
              v.baseProfileName ? { label: v.baseProfileName, value: v.baseProfileName } : null
            }
            onChange={({ detail }) => {
              const picked =
                candidateProfiles.find((p) => p.profileName === detail.selectedOption.value) ||
                null;
              const modes = baseModesFor(picked);
              set({
                baseProfileName: detail.selectedOption.value,
                baseAuthnMode: modes.length === 1 ? modes[0] : ""
              });
              setClusters([]);
              setServiceAccounts([]);
            }}
            options={candidateProfiles.map((p) => ({
              label: p.profileName,
              value: p.profileName,
              description: baseModesFor(p)
                .map((m) => AWS_MODE_LABELS[m] || m)
                .join(", ")
            }))}
            placeholder={
              candidateProfiles.length
                ? "Choose a profile"
                : "No IAM User or SSO profile exists yet"
            }
            empty="Create an AWS IAM User or AWS SSO profile first."
          />
        </FormField>

        <FormField label="Region" description="Defaults to us-east-1; type or pick another.">
          <Autosuggest
            value={v.region}
            onChange={({ detail }) => {
              set({ region: detail.value });
              setClusters([]);
              setServiceAccounts([]);
            }}
            options={COMMON_REGIONS.map((r) => ({ value: r }))}
            enteredTextLabel={(text) => `Use "${text}"`}
            placeholder={DEFAULT_IRSA_REGION}
          />
        </FormField>
      </ColumnLayout>

      {baseModes.length > 1 && (
        <FormField
          label="Base profile mechanism"
          description="That profile offers more than one AWS mechanism — pick the one to reach the cluster with."
        >
          <Select
            selectedOption={
              v.baseAuthnMode
                ? {
                    label: AWS_MODE_LABELS[v.baseAuthnMode] || v.baseAuthnMode,
                    value: v.baseAuthnMode
                  }
                : null
            }
            onChange={({ detail }) => set({ baseAuthnMode: detail.selectedOption.value })}
            options={baseModes.map((m) => ({ label: AWS_MODE_LABELS[m] || m, value: m }))}
            placeholder="Choose a mechanism"
          />
        </FormField>
      )}

      <FormField
        label="EKS cluster *"
        description="Listed from the base profile and region above."
      >
        <SpaceBetween direction="horizontal" size="xs" alignItems="end">
          <div style={{ minWidth: "320px" }}>
            <Select
              selectedOption={
                v.clusterName ? { label: v.clusterName, value: v.clusterName } : null
              }
              onChange={({ detail }) => {
                set({ clusterName: detail.selectedOption.value });
                setServiceAccounts([]);
              }}
              options={
                clusters.length
                  ? clusters.map((c) => ({ label: c, value: c }))
                  : v.clusterName
                    ? [{ label: v.clusterName, value: v.clusterName }]
                    : []
              }
              statusType={loadingClusters ? "loading" : "finished"}
              loadingText="Listing clusters…"
              placeholder="Load clusters, then choose one"
              empty="No clusters loaded yet."
            />
          </div>
          <Button
            iconName="refresh"
            onClick={handleLoadClusters}
            loading={loadingClusters}
            disabled={!v.baseProfileName}
          >
            Load clusters
          </Button>
        </SpaceBetween>
      </FormField>

      <FormField
        label="Service account"
        description="Only accounts annotated with eks.amazonaws.com/role-arn can assume a role."
      >
        <SpaceBetween direction="horizontal" size="xs" alignItems="end">
          <div style={{ minWidth: "320px" }}>
            <Select
              selectedOption={
                v.namespace && v.serviceAccount
                  ? {
                      label: `${v.namespace}/${v.serviceAccount}`,
                      value: `${v.namespace}/${v.serviceAccount}`
                    }
                  : null
              }
              onChange={({ detail }) => handlePickServiceAccount(detail.selectedOption)}
              options={serviceAccounts.map((sa) => ({
                label: `${sa.namespace}/${sa.name}`,
                value: `${sa.namespace}/${sa.name}`,
                description: sa.roleArn
              }))}
              statusType={loadingServiceAccounts ? "loading" : "finished"}
              loadingText="Listing service accounts…"
              placeholder="Load service accounts, then choose one"
              empty="No service accounts loaded yet."
            />
          </div>
          <Button
            iconName="refresh"
            onClick={handleLoadServiceAccounts}
            loading={loadingServiceAccounts}
            disabled={!v.baseProfileName || !v.clusterName}
          >
            Load service accounts
          </Button>
        </SpaceBetween>
      </FormField>

      <ColumnLayout columns={2}>
        <FormField label="Namespace *">
          <Input
            value={v.namespace}
            onChange={({ detail }) => set({ namespace: detail.value })}
            placeholder="default"
          />
        </FormField>
        <FormField label="Service account name *">
          <Input
            value={v.serviceAccount}
            onChange={({ detail }) => set({ serviceAccount: detail.value })}
            placeholder="my-service-account"
          />
        </FormField>
      </ColumnLayout>

      <FormField
        label="IRSA role ARN *"
        description="The role the service account assumes — its eks.amazonaws.com/role-arn annotation."
      >
        <SpaceBetween direction="horizontal" size="xs" alignItems="end">
          <div style={{ minWidth: "420px" }}>
            <Input
              value={v.roleArn}
              onChange={({ detail }) => set({ roleArn: detail.value })}
              placeholder="arn:aws:iam::123456789012:role/my-irsa-role"
            />
          </div>
          <Button
            onClick={() => inspectRole(v.roleArn, v.namespace, v.serviceAccount)}
            loading={loadingRole}
            disabled={!v.roleArn || !v.baseProfileName}
          >
            Check trust policy
          </Button>
        </SpaceBetween>
      </FormField>

      <FormField
        label="Audience"
        description="Leave blank to use whatever the role's trust policy requires (normally sts.amazonaws.com)."
      >
        <Input
          value={v.audience}
          onChange={({ detail }) => set({ audience: detail.value })}
          placeholder={roleFacts?.audience || "sts.amazonaws.com"}
        />
      </FormField>

      {roleFacts && (
        <Alert
          type={
            subjectCheck && subjectCheck.ok === false
              ? "warning"
              : roleFacts.trustPolicyReadable === false
                ? "info"
                : "success"
          }
          header={
            roleFacts.trustPolicyReadable === false
              ? "Trust policy not readable"
              : subjectCheck && subjectCheck.ok === false
                ? "The role does not trust this service account"
                : "Trust policy checked"
          }
        >
          <SpaceBetween size="xxs">
            {roleFacts.message && <Box>{roleFacts.message}</Box>}
            {subjectCheck && <Box>{subjectCheck.message}</Box>}
            {roleFacts.audience && (
              <Box variant="small">
                Required audience: <code>{roleFacts.audience}</code>
              </Box>
            )}
            {Array.isArray(roleFacts.oidcProviders) && roleFacts.oidcProviders.length > 0 && (
              <Box variant="small" color="text-body-secondary">
                OIDC provider: <code>{roleFacts.oidcProviders[0]}</code>
              </Box>
            )}
          </SpaceBetween>
        </Alert>
      )}

      <Box>
        <Button onClick={handleTest} loading={testing} iconName="status-positive">
          Test Connection
        </Button>
      </Box>

      {notice && (
        <Alert type="success" header={notice.header} dismissible onDismiss={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      <AuthorizeRetryAlert
        error={error}
        onRetry={retry || undefined}
        retryLabel="Retry"
      />

      {testResult && (
        <Alert type="success" header="IRSA credentials minted">
          <SpaceBetween size="xxs">
            <Box>{testResult.message}</Box>
            {testResult.subjectFromWebIdentityToken && (
              <Box variant="small">
                Token subject: <code>{testResult.subjectFromWebIdentityToken}</code>
              </Box>
            )}
            {testResult.credentials && (
              <Box variant="small" color="text-body-secondary">
                STS returned {testResult.credentials.accessKeyId}
                {testResult.credentials.expirationReadable
                  ? `, expiring ${testResult.credentials.expirationReadable}`
                  : ""}
                .
              </Box>
            )}
          </SpaceBetween>
        </Alert>
      )}
    </SpaceBetween>
  );
}

export default IrsaProfileForm;
