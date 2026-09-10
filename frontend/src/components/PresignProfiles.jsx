import React, { useState, useEffect } from "react";
import {
  Container,
  Header,
  Table,
  Input,
  Button,
  SpaceBetween,
  FormField,
  Box,
  Alert,
  Checkbox,
  ExpandableSection,
  Select,
  Textarea
} from "@cloudscape-design/components";
import * as presignApi from "./presignApi";
import { useConfirm } from "./ConfirmDialog";
import Ec2ProfileForm, {
  EMPTY_EC2,
  ec2FromProfile,
  ec2ToProfile
} from "./profiles/Ec2ProfileForm";
import IrsaProfileForm, {
  EMPTY_IRSA,
  irsaFromProfile,
  irsaToProfile
} from "./profiles/IrsaProfileForm";

// Sensible starter field sets for the two common OAuth2 grants. Users can
// add/remove/edit any of these — different providers need different fields
// (e.g. Auth0 wants `connection` and `audience`; many others do not).
const CLIENT_CREDENTIALS_TEMPLATE = [
  { key: "grant_type", value: "client_credentials" },
  { key: "client_id", value: "" },
  { key: "client_secret", value: "" },
  { key: "scope", value: "" },
  { key: "audience", value: "" }
];

const PASSWORD_TEMPLATE = [
  { key: "grant_type", value: "password" },
  { key: "client_id", value: "" },
  { key: "client_secret", value: "" },
  { key: "username", value: "" },
  { key: "password", value: "" },
  { key: "scope", value: "" }
];

function PresignProfiles() {
  const { confirm, confirmDialog } = useConfirm();
  const [profiles, setProfiles] = useState([]);
  const [selectedProfile, setSelectedProfile] = useState(null);
  const [profileName, setProfileName] = useState("");
  const [awsIamUserEnabled, setAwsIamUserEnabled] = useState(false);
  const [awsAccessKeyId, setAwsAccessKeyId] = useState("");
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState("");
  const [region, setRegion] = useState("");
  const [awsSsoUserEnabled, setAwsSsoUserEnabled] = useState(false);
  const [awsSsoStartUrl, setAwsSsoStartUrl] = useState("");
  const [awsSsoAccountId, setAwsSsoAccountId] = useState("");
  const [awsSsoRoleName, setAwsSsoRoleName] = useState("");
  const [ssoRegion, setSsoRegion] = useState("");

  // EC2 instance role / IRSA. Both sub-forms are controlled: they own no state of
  // their own beyond their discovery results, so buildProfile/clearForm/
  // handleRowClick stay readable here rather than being duplicated per type.
  const [ec2InstanceEnabled, setEc2InstanceEnabled] = useState(false);
  const [ec2, setEc2] = useState({ ...EMPTY_EC2 });
  const [irsaEnabled, setIrsaEnabled] = useState(false);
  const [irsa, setIrsa] = useState({ ...EMPTY_IRSA });

  // Basic Auth
  const [restBasicAuthEnabled, setRestBasicAuthEnabled] = useState(false);
  const [basicAuthUsername, setBasicAuthUsername] = useState("");
  const [basicAuthPassword, setBasicAuthPassword] = useState("");

  // Bearer Token
  const [restBearerTokenEnabled, setRestBearerTokenEnabled] = useState(false);
  const [bearerTokenMode, setBearerTokenMode] = useState("static"); // static | oauth2
  const [bearerStaticToken, setBearerStaticToken] = useState("");
  const [bearerTokenEndpoint, setBearerTokenEndpoint] = useState("");
  const [bearerTokenFields, setBearerTokenFields] = useState([...CLIENT_CREDENTIALS_TEMPLATE]);
  const [bearerTokenResponseField, setBearerTokenResponseField] = useState("access_token");
  // "Token to use" is only known after Test Connection tells us which tokens the
  // endpoint actually returns. Until a successful test, we hide that field.
  const [bearerTestPassed, setBearerTestPassed] = useState(false);
  const [bearerAvailableTokens, setBearerAvailableTokens] = useState([]);
  // Auto-renew: silently regenerate an expired token at invoke time (dashboard + chat).
  const [bearerAutoRenewOnExpiry, setBearerAutoRenewOnExpiry] = useState(false);

  const [genericEnabled, setGenericEnabled] = useState(false);
  // Sync to ~/.aws/config — applies only to AWS IAM User / AWS SSO User profiles.
  // Defaults ON for a fresh profile (see clearForm); handleRowClick overrides it
  // with the stored value when editing an existing profile.
  const [syncToAwsConfig, setSyncToAwsConfig] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [testConnResult, setTestConnResult] = useState(null);
  const [testConnError, setTestConnError] = useState(null);
  const [awsSyncWarning, setAwsSyncWarning] = useState(null);

  useEffect(() => {
    loadProfiles();
  }, []);

  const loadProfiles = async () => {
    try {
      const data = await presignApi.populateProfilesDetails();
      setProfiles(data || []);
    } catch (err) {
      setError("Failed to load profiles: " + err.message);
    }
  };

  const clearForm = () => {
    setProfileName("");
    setAwsIamUserEnabled(false);
    setAwsAccessKeyId("");
    setAwsSecretAccessKey("");
    setRegion("");
    setAwsSsoUserEnabled(false);
    setAwsSsoStartUrl("");
    setAwsSsoAccountId("");
    setAwsSsoRoleName("");
    setSsoRegion("");
    setEc2InstanceEnabled(false);
    setEc2({ ...EMPTY_EC2 });
    setIrsaEnabled(false);
    setIrsa({ ...EMPTY_IRSA });
    setRestBasicAuthEnabled(false);
    setBasicAuthUsername("");
    setBasicAuthPassword("");
    setRestBearerTokenEnabled(false);
    setBearerTokenMode("static");
    setBearerStaticToken("");
    setBearerTokenEndpoint("");
    setBearerTokenFields([...CLIENT_CREDENTIALS_TEMPLATE]);
    setBearerTokenResponseField("access_token");
    setBearerTestPassed(false);
    setBearerAvailableTokens([]);
    setBearerAutoRenewOnExpiry(false);
    setGenericEnabled(false);
    // Fresh profile: default "Sync to AWS Config" ON (only takes effect once the
    // user enables an AWS IAM User / SSO User type; forced off otherwise on save).
    setSyncToAwsConfig(true);
    setSelectedProfile(null);
    setError(null);
    setSuccess(null);
    setTestConnResult(null);
    setTestConnError(null);
    setAwsSyncWarning(null);
  };

  const handleRowClick = (profile) => {
    setSelectedProfile(profile);
    setProfileName(profile.profileName);
    setAwsIamUserEnabled(profile.awsIamUserEnabled || false);
    setAwsAccessKeyId(profile.awsAccessKeyId || "");
    setAwsSecretAccessKey(profile.awsSecretAccessKey || "");
    setRegion(profile.region || "");
    setAwsSsoUserEnabled(profile.awsSsoUserEnabled || false);
    setAwsSsoStartUrl(profile.awsSsoStartUrl || "");
    setAwsSsoAccountId(profile.awsSsoAccountId || "");
    setAwsSsoRoleName(profile.awsSsoRoleName || "");
    setSsoRegion(profile.ssoRegion || profile.region || "");
    setEc2InstanceEnabled(profile.ec2InstanceEnabled || false);
    setEc2(ec2FromProfile(profile));
    setIrsaEnabled(profile.irsaEnabled || false);
    setIrsa(irsaFromProfile(profile));
    setRestBasicAuthEnabled(profile.restBasicAuthEnabled || false);
    setBasicAuthUsername(profile.basicAuthUsername || "");
    setBasicAuthPassword(profile.basicAuthPassword || "");
    setRestBearerTokenEnabled(profile.restBearerTokenEnabled || false);
    setBearerTokenMode(profile.bearerTokenMode || "static");
    setBearerStaticToken(profile.bearerStaticToken || "");
    setBearerTokenEndpoint(profile.bearerTokenEndpoint || "");
    setBearerTokenFields(
      Array.isArray(profile.bearerTokenFields) && profile.bearerTokenFields.length
        ? profile.bearerTokenFields
        : [...CLIENT_CREDENTIALS_TEMPLATE]
    );
    setBearerTokenResponseField(profile.bearerTokenResponseField || "access_token");
    setBearerAutoRenewOnExpiry(profile.bearerAutoRenewOnExpiry === true || profile.bearerAutoRenewOnExpiry === "true");
    // A saved OAuth2 profile was already tested (its response field was derived),
    // so reveal "Token to use". Editing the fetch details resets this (see below).
    if (profile.restBearerTokenEnabled && (profile.bearerTokenMode || "static") === "oauth2" && profile.bearerTokenResponseField) {
      setBearerTestPassed(true);
      setBearerAvailableTokens([profile.bearerTokenResponseField]);
    } else {
      setBearerTestPassed(false);
      setBearerAvailableTokens([]);
    }
    setGenericEnabled(profile.genericEnabled || false);
    setSyncToAwsConfig(profile.syncToAwsConfig === true || profile.syncToAwsConfig === "true");
    setTestConnResult(null);
    setTestConnError(null);
  };

  // Any edit to the OAuth2 fetch details invalidates a prior successful test:
  // the endpoint may now return different tokens, so re-test before we trust
  // (or reveal) the "Token to use" selection again.
  const invalidateBearerTest = () => {
    setBearerTestPassed(false);
    setBearerAvailableTokens([]);
  };

  // ---- Bearer token field editor helpers ----
  const updateField = (index, prop, value) => {
    setBearerTokenFields((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [prop]: value };
      return next;
    });
    invalidateBearerTest();
  };

  const addField = () => {
    setBearerTokenFields((prev) => [...prev, { key: "", value: "" }]);
    invalidateBearerTest();
  };

  const removeField = (index) => {
    setBearerTokenFields((prev) => prev.filter((_, i) => i !== index));
    invalidateBearerTest();
  };

  const applyGrantTemplate = (grant) => {
    setBearerTokenFields(grant === "password" ? [...PASSWORD_TEMPLATE] : [...CLIENT_CREDENTIALS_TEMPLATE]);
    invalidateBearerTest();
  };

  const buildProfile = () => {
    const profile = { profileName };

    if (awsIamUserEnabled) {
      profile.awsIamUserEnabled = true;
      profile.awsAccessKeyId = awsAccessKeyId;
      profile.awsSecretAccessKey = awsSecretAccessKey;
      profile.region = region;
    } else {
      profile.awsIamUserEnabled = false;
    }

    if (awsSsoUserEnabled) {
      profile.awsSsoUserEnabled = true;
      profile.awsSsoStartUrl = awsSsoStartUrl;
      profile.awsSsoAccountId = awsSsoAccountId;
      profile.awsSsoRoleName = awsSsoRoleName;
      profile.ssoRegion = ssoRegion;
      if (!profile.region) {
        profile.region = ssoRegion;
      }
    } else {
      profile.awsSsoUserEnabled = false;
    }

    if (ec2InstanceEnabled) {
      profile.ec2InstanceEnabled = true;
      Object.assign(profile, ec2ToProfile(ec2));
    } else {
      profile.ec2InstanceEnabled = false;
    }

    if (irsaEnabled) {
      profile.irsaEnabled = true;
      Object.assign(profile, irsaToProfile(irsa));
    } else {
      profile.irsaEnabled = false;
    }

    if (restBasicAuthEnabled) {
      profile.restBasicAuthEnabled = true;
      profile.basicAuthUsername = basicAuthUsername;
      profile.basicAuthPassword = basicAuthPassword;
    } else {
      profile.restBasicAuthEnabled = false;
    }

    if (restBearerTokenEnabled) {
      profile.restBearerTokenEnabled = true;
      profile.bearerTokenMode = bearerTokenMode;
      if (bearerTokenMode === "static") {
        profile.bearerStaticToken = bearerStaticToken;
      } else {
        profile.bearerTokenEndpoint = bearerTokenEndpoint;
        profile.bearerTokenFields = bearerTokenFields.filter((f) => f.key);
        profile.bearerTokenResponseField = bearerTokenResponseField;
        profile.bearerAutoRenewOnExpiry = bearerAutoRenewOnExpiry;
      }
    } else {
      profile.restBearerTokenEnabled = false;
    }

    profile.genericEnabled = genericEnabled;

    // "Sync to AWS Config" only makes sense for AWS profiles; for anything else
    // it is forced off so a stale toggle can't leak onto a REST/Generic profile.
    profile.syncToAwsConfig = (awsIamUserEnabled || awsSsoUserEnabled) ? syncToAwsConfig : false;

    return profile;
  };

  // Run a bearer test-connection against the in-form (possibly unsaved) profile.
  // Returns { ok, message }. Never throws.
  const runBearerTest = async () => {
    const profile = buildProfile();
    const isOauth2 = bearerTokenMode === "oauth2";
    try {
      const result = await presignApi.testBearerTokenConnection(profileName, profile);
      const resp = result.response || {};
      if (resp.success) {
        // The backend inspects the token response and, per the grant type, tells
        // us which token to use (access_token for client_credentials, id_token for
        // password). Only now do we reveal "Token to use".
        if (isOauth2) {
          if (resp.recommendedTokenField) {
            setBearerTokenResponseField(resp.recommendedTokenField);
          }
          setBearerAvailableTokens(resp.availableTokens || []);
          setBearerTestPassed(true);
        }
        let msg = resp.message || "Connection successful";
        if (resp.availableTokens && resp.availableTokens.length > 1) {
          msg += ` Tokens returned: ${resp.availableTokens.join(", ")}.`;
        }
        return { ok: true, message: msg };
      }
      // Failed test: the required token was absent, or the call failed.
      if (isOauth2) {
        setBearerAvailableTokens(resp.availableTokens || []);
        setBearerTestPassed(false);
      }
      return { ok: false, message: resp.message || "Connection test failed" };
    } catch (err) {
      if (isOauth2) setBearerTestPassed(false);
      return { ok: false, message: err.response?.data?.message || err.message || "Connection test failed" };
    }
  };

  // Save = optionally test bearer first, then add/update. On a failed bearer
  // test we STILL save, but surface the root cause to the user.
  const saveProfile = async (isUpdate) => {
    if (!profileName) {
      setError("Profile name is required");
      return;
    }
    if (isUpdate && !selectedProfile) {
      setError("Please select a profile to update");
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);
    setTestConnResult(null);
    setTestConnError(null);
    setAwsSyncWarning(null);

    let bearerWarning = null;
    if (restBearerTokenEnabled) {
      const test = await runBearerTest();
      if (!test.ok) {
        bearerWarning = test.message;
      }
    }

    try {
      const profile = buildProfile();
      let saved;
      if (isUpdate) {
        saved = await presignApi.updateProfileDetails(profile);
      } else {
        saved = await presignApi.addProfileDetails(profile);
      }
      const syncWarning = saved && saved.awsSyncWarning;
      if (bearerWarning) {
        setSuccess(`Profile ${profileName} saved.`);
        setTestConnError(
          `Note: the profile was saved, but the bearer-token connection test failed: ${bearerWarning}`
        );
      } else {
        setSuccess(`Profile ${profileName} ${isUpdate ? "updated" : "created"} successfully`);
      }
      const nameForReload = profileName;
      clearForm();
      await loadProfiles();
      // keep the warning visible after clearing the form
      if (bearerWarning) {
        setTestConnError(
          `Profile "${nameForReload}" was saved, but the bearer-token connection test failed: ${bearerWarning}`
        );
      }
      if (syncWarning) {
        setAwsSyncWarning(syncWarning);
      }
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to save profile");
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = () => saveProfile(false);
  const handleUpdate = () => saveProfile(true);

  const handleDelete = async () => {
    if (!selectedProfile) {
      setError("Please select a profile to delete");
      return;
    }
    const confirmed = await confirm({
      title: "Delete profile",
      message: `Are you sure you want to delete profile ${selectedProfile.profileName}?`
    });
    if (!confirmed) {
      return;
    }
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const deletedName = selectedProfile.profileName;
      const result = await presignApi.deleteProfileDetails(selectedProfile);
      clearForm();
      await loadProfiles();
      // A 204 returns no body; a 200 with a message means the artifact was
      // deleted but the ~/.aws/config removal had a problem — surface it.
      if (result && result.message) {
        setAwsSyncWarning(result.message);
      } else {
        setSuccess(`Profile ${deletedName} deleted successfully`);
      }
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to delete profile");
    } finally {
      setLoading(false);
    }
  };

  const handleTestConnection = async () => {
    setLoading(true);
    setTestConnResult(null);
    setTestConnError(null);
    const test = await runBearerTest();
    if (test.ok) {
      setTestConnResult(test.message);
    } else {
      setTestConnError(test.message);
    }
    setLoading(false);
  };

  const handleCopyBearerToken = async () => {
    if (!selectedProfile || !selectedProfile.profileName) {
      setError("Please select (and save) a profile first");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await presignApi.copyBearerToken(selectedProfile.profileName);
      const token = result.response?.token;
      if (token) {
        navigator.clipboard.writeText(token);
        setSuccess("Bearer token copied to clipboard");
      } else {
        setError(result.response?.message || "No bearer token found in response");
      }
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to copy bearer token");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container
      header={
        <Header variant="h1" description="Manage authentication profiles">
          Profiles
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && (
          <Alert type="error" dismissible onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}
        {success && (
          <Alert type="success" dismissible onDismiss={() => setSuccess(null)}>
            {success}
          </Alert>
        )}
        {awsSyncWarning && (
          <Alert type="warning" dismissible onDismiss={() => setAwsSyncWarning(null)}>
            {awsSyncWarning}
          </Alert>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
          <Box>
            <Table
              columnDefinitions={[
                {
                  id: "profileName",
                  header: "Profile Name",
                  cell: (item) => item.profileName
                },
                {
                  id: "supportedAuthnMechanisms",
                  header: "Supported AuthN Mechanism",
                  cell: (item) =>
                    Array.isArray(item.supportedAuthnMechanisms)
                      ? item.supportedAuthnMechanisms.join(", ")
                      : item.supportedAuthnMechanisms || "Not specified"
                }
              ]}
              items={profiles}
              trackBy="profileName"
              onRowClick={({ detail }) => handleRowClick(detail.item)}
              onSelectionChange={({ detail }) => handleRowClick(detail.selectedItems[0])}
              selectedItems={selectedProfile ? [selectedProfile] : []}
              selectionType="single"
            />
          </Box>

          <Box>
            <SpaceBetween size="m">
              <FormField label="Profile Name *">
                <Input
                  value={profileName}
                  onChange={({ detail }) => setProfileName(detail.value)}
                  placeholder="Enter profile name"
                />
              </FormField>

              <Checkbox
                checked={awsIamUserEnabled}
                onChange={({ detail }) => setAwsIamUserEnabled(detail.checked)}
              >
                AWS IAM User
              </Checkbox>

              {awsIamUserEnabled && (
                <ExpandableSection headerText="AWS IAM User Details">
                  <SpaceBetween size="s">
                    <FormField label="AWS Access Key ID *">
                      <Input
                        value={awsAccessKeyId}
                        onChange={({ detail }) => setAwsAccessKeyId(detail.value)}
                        type="password"
                      />
                    </FormField>
                    <FormField label="AWS Secret Access Key *">
                      <Input
                        value={awsSecretAccessKey}
                        onChange={({ detail }) => setAwsSecretAccessKey(detail.value)}
                        type="password"
                      />
                    </FormField>
                    <FormField label="Region *">
                      <Input
                        value={region}
                        onChange={({ detail }) => setRegion(detail.value)}
                        placeholder="us-east-1"
                      />
                    </FormField>
                    <Checkbox
                      checked={syncToAwsConfig}
                      onChange={({ detail }) => setSyncToAwsConfig(detail.checked)}
                    >
                      Sync to AWS Config
                    </Checkbox>
                    <Box variant="small" color="text-body-secondary">
                      When enabled, this profile is also written to <code>~/.aws/config</code> (and
                      access keys to <code>~/.aws/credentials</code>) so you can use it outside
                      SignBridge, e.g. with the AWS CLI. Profiles loaded from <code>~/.aws/config</code>{" "}
                      have this enabled by default.
                    </Box>
                  </SpaceBetween>
                </ExpandableSection>
              )}

              <Checkbox
                checked={awsSsoUserEnabled}
                onChange={({ detail }) => setAwsSsoUserEnabled(detail.checked)}
              >
                AWS SSO User
              </Checkbox>

              {awsSsoUserEnabled && (
                <ExpandableSection headerText="AWS SSO User Details">
                  <SpaceBetween size="s">
                    <FormField label="SSO Start URL *">
                      <Input
                        value={awsSsoStartUrl}
                        onChange={({ detail }) => setAwsSsoStartUrl(detail.value)}
                      />
                    </FormField>
                    <FormField label="SSO Account ID *">
                      <Input
                        value={awsSsoAccountId}
                        onChange={({ detail }) => setAwsSsoAccountId(detail.value)}
                      />
                    </FormField>
                    <FormField label="SSO Role Name *">
                      <Input
                        value={awsSsoRoleName}
                        onChange={({ detail }) => setAwsSsoRoleName(detail.value)}
                      />
                    </FormField>
                    <FormField label="SSO Region *">
                      <Input
                        value={ssoRegion}
                        onChange={({ detail }) => setSsoRegion(detail.value)}
                        placeholder="us-east-1"
                      />
                    </FormField>
                    <Checkbox
                      checked={syncToAwsConfig}
                      onChange={({ detail }) => setSyncToAwsConfig(detail.checked)}
                    >
                      Sync to AWS Config
                    </Checkbox>
                    <Box variant="small" color="text-body-secondary">
                      When enabled, this profile is also written to <code>~/.aws/config</code> so you
                      can use it outside SignBridge, e.g. with the AWS CLI. Profiles loaded from{" "}
                      <code>~/.aws/config</code> have this enabled by default.
                    </Box>
                  </SpaceBetween>
                </ExpandableSection>
              )}

              <Checkbox
                checked={ec2InstanceEnabled}
                onChange={({ detail }) => setEc2InstanceEnabled(detail.checked)}
              >
                AWS EC2 Instance Role
              </Checkbox>

              {ec2InstanceEnabled && (
                <ExpandableSection headerText="AWS EC2 Instance Role Details" defaultExpanded>
                  <Ec2ProfileForm value={ec2} onChange={setEc2} profileName={profileName} />
                </ExpandableSection>
              )}

              <Checkbox
                checked={irsaEnabled}
                onChange={({ detail }) => setIrsaEnabled(detail.checked)}
              >
                AWS IRSA (EKS Service Account)
              </Checkbox>

              {irsaEnabled && (
                <ExpandableSection headerText="AWS IRSA Details" defaultExpanded>
                  <IrsaProfileForm
                    value={irsa}
                    onChange={setIrsa}
                    profileName={profileName}
                    profiles={profiles}
                  />
                </ExpandableSection>
              )}

              <Checkbox
                checked={restBasicAuthEnabled}
                onChange={({ detail }) => setRestBasicAuthEnabled(detail.checked)}
              >
                Basic Auth
              </Checkbox>

              {restBasicAuthEnabled && (
                <ExpandableSection headerText="Basic Auth Details">
                  <SpaceBetween size="s">
                    <FormField label="Username *">
                      <Input
                        value={basicAuthUsername}
                        onChange={({ detail }) => setBasicAuthUsername(detail.value)}
                      />
                    </FormField>
                    <FormField label="Password *">
                      <Input
                        value={basicAuthPassword}
                        onChange={({ detail }) => setBasicAuthPassword(detail.value)}
                        type="password"
                      />
                    </FormField>
                  </SpaceBetween>
                </ExpandableSection>
              )}

              <Checkbox
                checked={restBearerTokenEnabled}
                onChange={({ detail }) => setRestBearerTokenEnabled(detail.checked)}
              >
                Bearer Token
              </Checkbox>

              {restBearerTokenEnabled && (
                <ExpandableSection headerText="Bearer Token Details" defaultExpanded>
                  <SpaceBetween size="s">
                    <FormField label="Token Source">
                      <Select
                        selectedOption={
                          bearerTokenMode === "oauth2"
                            ? { label: "Fetch dynamically (OAuth2)", value: "oauth2" }
                            : { label: "Static token", value: "static" }
                        }
                        onChange={({ detail }) => setBearerTokenMode(detail.selectedOption.value)}
                        options={[
                          { label: "Static token", value: "static" },
                          { label: "Fetch dynamically (OAuth2)", value: "oauth2" }
                        ]}
                      />
                    </FormField>

                    {bearerTokenMode === "static" && (
                      <FormField label="Bearer Token *" description="Sent as 'Authorization: Bearer <token>'.">
                        <Textarea
                          value={bearerStaticToken}
                          onChange={({ detail }) => setBearerStaticToken(detail.value)}
                          placeholder="Paste your bearer token"
                          rows={3}
                        />
                      </FormField>
                    )}

                    {bearerTokenMode === "oauth2" && (
                      <SpaceBetween size="s">
                        <FormField
                          label="Token Endpoint *"
                          description="OAuth2 token URL, e.g. https://your-tenant.example.com/oauth/token"
                        >
                          <Input
                            value={bearerTokenEndpoint}
                            onChange={({ detail }) => setBearerTokenEndpoint(detail.value)}
                            placeholder="https://.../oauth/token"
                          />
                        </FormField>

                        <FormField
                          label="Request Fields"
                          description="Sent as application/x-www-form-urlencoded to the token endpoint. Add, remove, or edit fields to match your OAuth2 provider (e.g. Auth0 needs 'connection' and 'audience')."
                        >
                          <SpaceBetween size="xs">
                            <SpaceBetween direction="horizontal" size="xs">
                              <Button onClick={() => applyGrantTemplate("client_credentials")}>
                                client_credentials template
                              </Button>
                              <Button onClick={() => applyGrantTemplate("password")}>
                                password template
                              </Button>
                            </SpaceBetween>
                            {bearerTokenFields.map((field, index) => (
                              <SpaceBetween key={index} direction="horizontal" size="xs">
                                <Input
                                  value={field.key}
                                  onChange={({ detail }) => updateField(index, "key", detail.value)}
                                  placeholder="key"
                                />
                                <Input
                                  value={field.value}
                                  onChange={({ detail }) => updateField(index, "value", detail.value)}
                                  placeholder="value"
                                  type={
                                    /secret|password/i.test(field.key) ? "password" : "text"
                                  }
                                />
                                <Button iconName="close" variant="icon" onClick={() => removeField(index)} />
                              </SpaceBetween>
                            ))}
                            <Button iconName="add-plus" onClick={addField}>
                              Add field
                            </Button>
                          </SpaceBetween>
                        </FormField>

                        {bearerTestPassed ? (
                          <FormField
                            label="Token to use"
                            description="Detected from the token response. client_credentials uses access_token; password uses id_token."
                          >
                            <Select
                              selectedOption={{ label: bearerTokenResponseField, value: bearerTokenResponseField }}
                              onChange={({ detail }) => setBearerTokenResponseField(detail.selectedOption.value)}
                              options={(bearerAvailableTokens.length ? bearerAvailableTokens : [bearerTokenResponseField]).map(
                                (t) => ({ label: t, value: t })
                              )}
                            />
                          </FormField>
                        ) : (
                          <Box variant="small" color="text-body-secondary">
                            Run <b>Test Connection</b> to detect which token the endpoint returns and choose the token to use.
                          </Box>
                        )}

                        <Checkbox
                          checked={bearerAutoRenewOnExpiry}
                          onChange={({ detail }) => setBearerAutoRenewOnExpiry(detail.checked)}
                        >
                          Automatically renew the token on expiry
                        </Checkbox>
                        <Box variant="small" color="text-body-secondary">
                          When enabled, an expired token is regenerated automatically at invoke time (from the dashboard and
                          from Chat) instead of failing the request.
                        </Box>
                      </SpaceBetween>
                    )}

                    <SpaceBetween direction="horizontal" size="s">
                      <Button onClick={handleTestConnection} loading={loading}>
                        Test Connection
                      </Button>
                      <Button onClick={handleCopyBearerToken} loading={loading} disabled={!selectedProfile}>
                        Copy Bearer Token
                      </Button>
                    </SpaceBetween>
                    {testConnResult && <Alert type="success">{testConnResult}</Alert>}
                    {testConnError && <Alert type="warning">{testConnError}</Alert>}
                  </SpaceBetween>
                </ExpandableSection>
              )}

              <Checkbox
                checked={genericEnabled}
                onChange={({ detail }) => setGenericEnabled(detail.checked)}
              >
                Generic (no signing)
              </Checkbox>

              <SpaceBetween direction="horizontal" size="s">
                <Button onClick={handleAdd} loading={loading} disabled={loading}>
                  Add
                </Button>
                <Button onClick={handleUpdate} loading={loading} disabled={loading || !selectedProfile}>
                  Update
                </Button>
                <Button onClick={handleDelete} loading={loading} disabled={loading || !selectedProfile}>
                  Remove
                </Button>
                <Button onClick={clearForm} disabled={loading}>
                  Clear
                </Button>
              </SpaceBetween>
            </SpaceBetween>
          </Box>
        </div>
      </SpaceBetween>
      {confirmDialog}
    </Container>
  );
}

export default PresignProfiles;
