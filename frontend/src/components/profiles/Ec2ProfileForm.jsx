import React, { useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  ColumnLayout,
  FormField,
  Input,
  RadioGroup,
  SpaceBetween,
  Textarea
} from "@cloudscape-design/components";
import * as presignApi from "../presignApi";
import AuthorizeRetryAlert from "../AuthorizeRetryAlert";
import { describeError } from "../../utils/awsRequestUtils";

// The EC2 instance-role sub-form.
//
// The profile names an instance you can already SSH into; SignBridge logs in and
// reads IMDSv2 on the box, so the instance's own role becomes something you can
// presign and invoke with. Two things about this form are deliberate:
//
//   * "Key or password, never both" is enforced by a radio group rather than by
//     validation. The backend rejects both being set (ec2Utils.validateSshConfig),
//     but a form that cannot express the invalid state is better than one that
//     explains it afterwards.
//   * Test Connection is the whole point of the form. SSH failures are ambiguous
//     — a security group, a wrong username and a missing route all look the same
//     — so the result panel shows the backend's specific diagnosis plus, on
//     success, the instance identity IMDS returned, which is how the user knows
//     they are on the box they meant.

export const EMPTY_EC2 = {
  host: "",
  sshUsername: "",
  sshPort: "",
  credentialSource: "key", // key | password
  sshPrivateKey: "",
  sshPrivateKeyFileName: "",
  sshPrivateKeyPassphrase: "",
  sshPassword: ""
};

// A saved profile -> form value.
export function ec2FromProfile(profile) {
  if (!profile) {
    return { ...EMPTY_EC2 };
  }
  return {
    host: profile.ec2Host || "",
    sshUsername: profile.ec2SshUsername || "",
    sshPort: profile.ec2SshPort ? String(profile.ec2SshPort) : "",
    credentialSource: profile.ec2SshPassword && !profile.ec2SshPrivateKey ? "password" : "key",
    sshPrivateKey: profile.ec2SshPrivateKey || "",
    sshPrivateKeyFileName: profile.ec2SshPrivateKey ? "stored key" : "",
    sshPrivateKeyPassphrase: profile.ec2SshPrivateKeyPassphrase || "",
    sshPassword: profile.ec2SshPassword || ""
  };
}

// Form value -> the profile fields the backend reads. Only the selected
// credential source is written, so switching from a key to a password does not
// leave both on the saved profile (which the backend would reject).
export function ec2ToProfile(value) {
  const v = value || EMPTY_EC2;
  const profile = {
    ec2Host: (v.host || "").trim(),
    ec2SshUsername: (v.sshUsername || "").trim()
  };
  const port = parseInt(v.sshPort, 10);
  if (!isNaN(port) && port > 0) {
    profile.ec2SshPort = port;
  }
  if (v.credentialSource === "password") {
    profile.ec2SshPassword = v.sshPassword || "";
    profile.ec2SshPrivateKey = "";
    profile.ec2SshPrivateKeyPassphrase = "";
  } else {
    profile.ec2SshPrivateKey = v.sshPrivateKey || "";
    profile.ec2SshPrivateKeyPassphrase = v.sshPrivateKeyPassphrase || "";
    profile.ec2SshPassword = "";
  }
  return profile;
}

function Ec2ProfileForm({ value, onChange, profileName }) {
  const v = value || EMPTY_EC2;
  const set = (patch) => onChange({ ...v, ...patch });

  const fileInputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState(null);

  const readKeyFile = (file) => {
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      // Picking the .pub is the commonest mistake here, and saying so now beats a
      // confusing "authentication methods failed" after the SSH attempt.
      if (/^ssh-(rsa|ed25519|dss)|^ecdsa-sha2-/.test(text.trim())) {
        setTestError(
          `${file.name} is a public key. Choose the matching private key file (usually the same name without .pub).`
        );
        return;
      }
      setTestError(null);
      set({
        sshPrivateKey: text,
        sshPrivateKeyFileName: file.name,
        credentialSource: "key"
      });
      setPasting(false);
    };
    reader.onerror = () => {
      setTestError(`Could not read ${file.name}.`);
    };
    reader.readAsText(file);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    readKeyFile(file);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const result = await presignApi.testEc2Connection(profileName || null, {
        profileName: profileName || undefined,
        ec2InstanceEnabled: true,
        ...ec2ToProfile(v)
      });
      if (result && result.success) {
        setTestResult(result);
      } else {
        // A failure body and an axios rejection carry the same fields, so both
        // take the same path — and both get the Retry that re-runs the test.
        setTestError(describeError(result, "The SSH connection test failed."));
      }
    } catch (err) {
      setTestError(describeError(err, "The SSH connection test failed."));
    } finally {
      setTesting(false);
    }
  };

  const metadata = testResult && testResult.instanceMetadata;

  return (
    <SpaceBetween size="s">
      <ColumnLayout columns={2}>
        <FormField
          label="EC2 host *"
          description="Public/private IP or DNS name — whatever you would pass to ssh."
        >
          <Input
            value={v.host}
            onChange={({ detail }) => set({ host: detail.value })}
            placeholder="10.20.30.40 or ec2-1-2-3-4.compute-1.amazonaws.com"
          />
        </FormField>
        <FormField
          label="SSH username *"
          description="ec2-user on Amazon Linux, ubuntu on Ubuntu, admin on Debian."
        >
          <Input
            value={v.sshUsername}
            onChange={({ detail }) => set({ sshUsername: detail.value })}
            placeholder="ec2-user"
          />
        </FormField>
      </ColumnLayout>

      <FormField label="SSH port" description="Leave blank for 22.">
        <Input
          value={v.sshPort}
          onChange={({ detail }) => set({ sshPort: detail.value })}
          type="number"
          placeholder="22"
        />
      </FormField>

      <FormField label="Authenticate with">
        <RadioGroup
          value={v.credentialSource}
          onChange={({ detail }) => set({ credentialSource: detail.value })}
          items={[
            { value: "key", label: "SSH private key" },
            { value: "password", label: "SSH password" }
          ]}
        />
      </FormField>

      {v.credentialSource === "key" && (
        <FormField
          label="SSH private key *"
          description="The private key file (e.g. my-key.pem) — not the .pub. It is stored with the profile and never logged."
        >
          <SpaceBetween size="xs">
            {v.sshPrivateKey ? (
              <Box>
                <SpaceBetween direction="horizontal" size="xs">
                  <Box variant="strong">
                    {v.sshPrivateKeyFileName || "private key"} loaded
                  </Box>
                  <Box variant="small" color="text-body-secondary">
                    {v.sshPrivateKey.length} characters
                  </Box>
                  <Button
                    variant="inline-link"
                    onClick={() => set({ sshPrivateKey: "", sshPrivateKeyFileName: "" })}
                  >
                    Remove
                  </Button>
                </SpaceBetween>
              </Box>
            ) : (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                style={{
                  border: `2px dashed ${dragActive ? "#0972d3" : "#b6bec9"}`,
                  borderRadius: "8px",
                  padding: "16px",
                  textAlign: "center",
                  background: dragActive ? "#f0f7ff" : "transparent"
                }}
              >
                <SpaceBetween size="xxs">
                  <Box variant="small" color="text-body-secondary">
                    Drop your .pem / id_rsa file here
                  </Box>
                  <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                    <Button
                      iconName="upload"
                      onClick={() => fileInputRef.current && fileInputRef.current.click()}
                    >
                      Choose key file
                    </Button>
                    <Button variant="inline-link" onClick={() => setPasting((p) => !p)}>
                      {pasting ? "Cancel paste" : "Paste a key instead"}
                    </Button>
                  </SpaceBetween>
                </SpaceBetween>
                <input
                  ref={fileInputRef}
                  type="file"
                  style={{ display: "none" }}
                  onChange={(e) => readKeyFile(e.target.files && e.target.files[0])}
                />
              </div>
            )}

            {pasting && !v.sshPrivateKey && (
              <Textarea
                value={v.sshPrivateKey}
                onChange={({ detail }) =>
                  set({ sshPrivateKey: detail.value, sshPrivateKeyFileName: "pasted key" })
                }
                placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n..."}
                rows={6}
              />
            )}

            <FormField
              label="Key passphrase"
              description="Only if the key file is encrypted. Leave blank otherwise."
            >
              <Input
                value={v.sshPrivateKeyPassphrase}
                onChange={({ detail }) => set({ sshPrivateKeyPassphrase: detail.value })}
                type="password"
              />
            </FormField>
          </SpaceBetween>
        </FormField>
      )}

      {v.credentialSource === "password" && (
        <FormField
          label="SSH password *"
          description="Most AMIs ship with PasswordAuthentication disabled; if the test fails on authentication, use a key instead."
        >
          <Input
            value={v.sshPassword}
            onChange={({ detail }) => set({ sshPassword: detail.value })}
            type="password"
          />
        </FormField>
      )}

      <Box>
        <Button onClick={handleTest} loading={testing} iconName="status-positive">
          Test Connection
        </Button>
      </Box>

      <AuthorizeRetryAlert
        error={testError}
        onRetry={handleTest}
        retryLabel="Test again"
      />

      {testResult && (
        <Alert type="success" header="SSH connection succeeded">
          <SpaceBetween size="xs">
            <Box>{testResult.message}</Box>
            {metadata && (
              <ColumnLayout columns={3} variant="text-grid">
                <div>
                  <Box variant="awsui-key-label">Instance</Box>
                  <Box>{metadata.instanceId}</Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">Type</Box>
                  <Box>{metadata.instanceType}</Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">Account</Box>
                  <Box>{metadata.accountId}</Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">Region</Box>
                  <Box>{metadata.region}</Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">Availability zone</Box>
                  <Box>{metadata.availabilityZone}</Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">Instance role</Box>
                  <Box>{metadata.iamRoleName}</Box>
                </div>
              </ColumnLayout>
            )}
            {testResult.credentials && (
              <Box variant="small" color="text-body-secondary">
                IMDSv2 returned credentials {testResult.credentials.accessKeyId}
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

export default Ec2ProfileForm;
