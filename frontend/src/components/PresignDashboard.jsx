import React, { useState, useEffect, Suspense, lazy } from "react";
import {
  Container,
  Header,
  Select,
  RadioGroup,
  Input,
  Textarea,
  Button,
  SpaceBetween,
  FormField,
  Box,
  Alert,
  ExpandableSection,
  Table,
  Spinner
} from "@cloudscape-design/components";
import * as presignApi from "./presignApi";
import {
  buildAwsHeaders,
  extractPendingAuthUrl,
  extractPresignedUrl,
  formatApiResponse,
  formatErrorResponse
} from "../utils/awsRequestUtils";
import { buildCurlCommand } from "../utils/buildCurl";
import { authnLabel, isAwsMode } from "../authnModes";

// Lazy, because SandboxIde pulls in Monaco (~4.5 MB) and the embedded editor
// only renders once the user picks the Sandbox invocation mode. Importing it
// eagerly made the dashboard — the app's landing route — pay for the editor on
// every visit.
const SandboxIde = lazy(() => import("./SandboxIde.jsx"));

function PresignDashboard({ onProfileChange }) {
  const [profiles, setProfiles] = useState([]);
  const [selectedProfile, setSelectedProfile] = useState(null);
  const [authnMechanisms, setAuthnMechanisms] = useState([]);
  const [selectedAuthnMechanism, setSelectedAuthnMechanism] = useState(null);
  const [invocationMode, setInvocationMode] = useState("Rest_Api");
  const [httpMethod, setHttpMethod] = useState("GET");
  const [endpoint, setEndpoint] = useState("");
  const [contentType, setContentType] = useState("application/json");
  const [customContentType, setCustomContentType] = useState("");
  const [payload, setPayload] = useState("");
  const [payloadType, setPayloadType] = useState("raw");
  const [commandPayload, setCommandPayload] = useState("");
  const [headers, setHeaders] = useState([
    { key: "", value: "" },
    { key: "", value: "" },
    { key: "", value: "" },
    { key: "", value: "" },
    { key: "", value: "" }
  ]);
  const [queryParams, setQueryParams] = useState([]);
  const [queryParamKey, setQueryParamKey] = useState("");
  const [queryParamValue, setQueryParamValue] = useState("");
  const [response, setResponse] = useState("");
  const [responseHtml, setResponseHtml] = useState(null);
  // Per-action progress: only the button that was clicked spins, but every
  // button is disabled while either is in progress. `processing` drives the
  // "Processing your request…" placeholder shown in place of the old response.
  const [presigning, setPresigning] = useState(false);
  const [invoking, setInvoking] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  // An AWS SSO device authorization waiting to be approved: { url, retry }.
  // Held separately from `error` because it is not a failure — it is a step the
  // user has still to take, and it has two actions (Authorize, then Retry the
  // same request) rather than a dismissible message.
  const [pendingAuth, setPendingAuth] = useState(null);
  const [binaryFileName, setBinaryFileName] = useState("");
  // Presigned-URL lifetime (seconds). Only applies to presign, not invoke.
  const [presignExpiry, setPresignExpiry] = useState("3600");
  // "Copy as curl" lives inside the Response panel (alongside "Copy") and only
  // appears once a request has actually been presigned/invoked. curlContext is a
  // snapshot of what was just run, so the copied command matches the response
  // exactly even if the user edits the form afterwards. curlBusy guards the
  // buttons while the self-sufficient command is built.
  const [curlContext, setCurlContext] = useState(null);
  const [curlBusy, setCurlBusy] = useState(false);

  const contentTypes = [
    { value: "application/json", label: "application/json" },
    { value: "text/html", label: "text/html" },
    { value: "application/x-www-form-urlencoded; charset=utf-8", label: "application/x-www-form-urlencoded; charset=utf-8" },
    { value: "custom", label: "Specify Custom Content-Type" }
  ];

  const httpMethods = [
    { value: "GET", label: "GET" },
    { value: "POST", label: "POST" },
    { value: "PUT", label: "PUT" },
    { value: "PATCH", label: "PATCH" },
    { value: "DELETE", label: "DELETE" }
  ];

  // Sandbox is a full third invocation mode: picking it swaps this form for the
  // code editor in place, the same way picking Cli swaps it for the command box.
  // The profile and auth mechanism selected above stay in view and drive the
  // editor's runs, so nothing is chosen twice and nothing navigates away.
  const invocationModes = [
    { value: "Rest_Api", label: "Rest_Api" },
    { value: "Cli", label: "Cli" },
    { value: "Sandbox", label: "Sandbox (write & run code)" }
  ];

  // Sandbox has no Presign/Invoke/Execute — the editor owns its own Run,
  // Validate and Stop controls, and its own output pane.
  const isSandbox = invocationMode === "Sandbox";

  // Presigned-URL expiry choices. AWS SigV4 allows up to 12h; for SSO profiles
  // the URL is further capped to the session credential's remaining life.
  const presignExpiryOptions = [
    { value: "900", label: "15 minutes" },
    { value: "1800", label: "30 minutes" },
    { value: "3600", label: "1 hour" },
    { value: "7200", label: "2 hours" },
    { value: "14400", label: "4 hours" },
    { value: "28800", label: "8 hours" },
    { value: "43200", label: "12 hours (max)" }
  ];

  useEffect(() => {
    if (selectedProfile && selectedAuthnMechanism && onProfileChange) {
      onProfileChange({
        profileName: selectedProfile,
        authnMode: selectedAuthnMechanism
      });
    }
  }, [selectedProfile, selectedAuthnMechanism, onProfileChange]);

  useEffect(() => {
    loadProfiles();
  }, []);

  // Load pinned data after profiles are loaded
  useEffect(() => {
    if (profiles.length > 0) {
      const pinnedDataStr = localStorage.getItem('signBridgePinnedRequest');
      if (pinnedDataStr) {
        try {
          const pinnedData = JSON.parse(pinnedDataStr);
          
          // Set profile first
          if (pinnedData.profileName) {
            setSelectedProfile(pinnedData.profileName);
          }
          
          // Clear pinned data after reading
          localStorage.removeItem('signBridgePinnedRequest');
        } catch (err) {
          console.error('Error loading pinned request:', err);
          localStorage.removeItem('signBridgePinnedRequest');
        }
      }
    }
  }, [profiles]);

  // Apply pinned data after authn mechanisms are loaded
  useEffect(() => {
    if (authnMechanisms.length > 0 && selectedProfile) {
      const pinnedDataStr = sessionStorage.getItem('signBridgePinnedDataToApply');
      if (pinnedDataStr) {
        try {
          const pinnedData = JSON.parse(pinnedDataStr);
          
          // Set authentication mechanism
          if (pinnedData.authnMechanism) {
            setSelectedAuthnMechanism(pinnedData.authnMechanism);
          }
          
          // Set invocation mode
          if (pinnedData.invocationMode) {
            setInvocationMode(pinnedData.invocationMode);
          }
          
          // Set HTTP method and endpoint for REST API
          if (pinnedData.invocationMode === "Rest_Api" || !pinnedData.invocationMode) {
            if (pinnedData.httpMethod) {
              setHttpMethod(pinnedData.httpMethod);
            }
            if (pinnedData.endpoint) {
              // Set query parameters if available
              if (pinnedData.queryParams && pinnedData.queryParams.length > 0) {
                setQueryParams(pinnedData.queryParams);
                // Update endpoint with query parameters (without encoding)
                const baseUrl = pinnedData.endpoint.split("?")[0];
                const queryParts = pinnedData.queryParams
                  .filter((param) => param.key && param.value !== undefined && param.value !== null && param.value !== "")
                  .map((param) => `${param.key}=${param.value}`);
                if (queryParts.length > 0) {
                  setEndpoint(`${baseUrl}?${queryParts.join("&")}`);
                } else {
                  setEndpoint(baseUrl);
                }
              } else {
                // No query params, just set the endpoint
                setEndpoint(pinnedData.endpoint);
                // Parse query parameters from endpoint if present
                if (pinnedData.endpoint.includes("?")) {
                  try {
                    // Extract query string manually without decoding
                    const queryString = pinnedData.endpoint.split("?")[1];
                    if (queryString) {
                      const params = [];
                      queryString.split("&").forEach((param) => {
                        const equalIndex = param.indexOf("=");
                        if (equalIndex > 0) {
                          const key = param.substring(0, equalIndex);
                          const value = param.substring(equalIndex + 1);
                          params.push({ key, value });
                        } else if (param) {
                          // Handle params without values
                          params.push({ key: param, value: "" });
                        }
                      });
                      if (params.length > 0) {
                        setQueryParams(params);
                        // Endpoint already includes query params, so no change needed
                      }
                    }
                  } catch (e) {
                    // Invalid URL, ignore
                    console.warn('Error parsing query params from endpoint:', e);
                  }
                }
              }
            }
          }
          
          // Set command payload for CLI
          if (pinnedData.invocationMode === "Cli" && pinnedData.commandPayload) {
            setCommandPayload(pinnedData.commandPayload);
          }
          
          // Set payload
          if (pinnedData.payload) {
            setPayload(pinnedData.payload);
          }
          
          // Set content type
          if (pinnedData.contentType) {
            const defaultContentTypes = ["application/json", "text/html", "application/x-www-form-urlencoded; charset=utf-8"];
            if (defaultContentTypes.includes(pinnedData.contentType)) {
              setContentType(pinnedData.contentType);
            } else {
              setContentType("custom");
              if (pinnedData.customContentType) {
                setCustomContentType(pinnedData.customContentType);
              } else {
                setCustomContentType(pinnedData.contentType);
              }
            }
          }
          
          // Set headers
          if (pinnedData.headers && typeof pinnedData.headers === 'object') {
            const headerEntries = Object.entries(pinnedData.headers);
            const newHeaders = [
              { key: "", value: "" },
              { key: "", value: "" },
              { key: "", value: "" },
              { key: "", value: "" },
              { key: "", value: "" }
            ];
            
            // Filter out Content-Type, Authorization, Accept (handled separately)
            const filteredHeaders = headerEntries.filter(([key]) => {
              const lowerKey = key.toLowerCase();
              return lowerKey !== 'content-type' && lowerKey !== 'authorization' && lowerKey !== 'accept';
            });
            
            filteredHeaders.slice(0, 5).forEach(([key, value], index) => {
              newHeaders[index] = { key, value };
            });
            
            setHeaders(newHeaders);
          }
          
          // Clear session storage
          sessionStorage.removeItem('signBridgePinnedDataToApply');
          
          setSuccess("Request details have been loaded from pinned request.");
        } catch (err) {
          console.error('Error applying pinned request:', err);
          sessionStorage.removeItem('signBridgePinnedDataToApply');
        }
      }
    }
  }, [authnMechanisms, selectedProfile]);

  useEffect(() => {
    if (selectedProfile) {
      loadAuthnMechanisms(selectedProfile);
    } else {
      setAuthnMechanisms([]);
      setSelectedAuthnMechanism(null);
    }
  }, [selectedProfile]);

  useEffect(() => {
    if (endpoint && endpoint.includes("?")) {
      parseQueryParams();
    }
  }, [endpoint]);

  const loadProfiles = async () => {
    try {
      const data = await presignApi.populateProfilesDetails();
      const profileOptions = [{ value: null, label: "Select Profile" }];
      if (data && data.length > 0) {
        data.forEach((profile) => {
          profileOptions.push({
            value: profile.profileName,
            label: profile.profileName
          });
        });
      }
      setProfiles(profileOptions);
    } catch (err) {
      setError("Failed to load profiles: " + err.message);
    }
  };

  const loadAuthnMechanisms = async (profileName) => {
    try {
      const data = await presignApi.populateProfilesDetails();
      const profile = data.find((p) => p.profileName === profileName);
      if (profile && profile.supportedAuthnMechanisms) {
        // Labels come from authnModes so the dropdown reads "AWS EC2 Instance
        // Role" rather than the raw `ec2_instance` the profile stores.
        const mechanisms = profile.supportedAuthnMechanisms.map((m) => ({
          value: m,
          label: authnLabel(m)
        }));
        setAuthnMechanisms([
          { value: null, label: "Select Authentication Mechanism" },
          ...mechanisms
        ]);
      }
    } catch (err) {
      setError("Failed to load authentication mechanisms: " + err.message);
    }
  };

  const parseQueryParams = () => {
    try {
      // Parse query string manually without decoding (preserve original values)
      if (endpoint.includes("?")) {
        const queryString = endpoint.split("?")[1];
        if (queryString) {
          const params = [];
          queryString.split("&").forEach((param) => {
            const equalIndex = param.indexOf("=");
            if (equalIndex > 0) {
              const key = param.substring(0, equalIndex);
              const value = param.substring(equalIndex + 1);
              params.push({ key, value });
            } else if (param) {
              // Handle params without values
              params.push({ key: param, value: "" });
            }
          });
          setQueryParams(params);
        }
      }
    } catch (e) {
      // Invalid URL, ignore
      console.warn('Error parsing query params:', e);
    }
  };

  const addQueryParam = () => {
    if (queryParamKey) {
      const newParams = [...queryParams, { key: queryParamKey, value: queryParamValue }];
      setQueryParams(newParams);
      updateEndpointWithParams(newParams);
      setQueryParamKey("");
      setQueryParamValue("");
    }
  };

  const removeQueryParam = (index) => {
    const newParams = queryParams.filter((_, i) => i !== index);
    setQueryParams(newParams);
    updateEndpointWithParams(newParams);
  };

  const updateEndpointWithParams = (params) => {
    try {
      // Get base URL without query parameters
      const baseUrl = endpoint.split("?")[0] || endpoint;
      
      // Build query string manually without encoding (as user provided)
      const queryParts = params
        .filter((param) => param.key && param.value !== undefined && param.value !== null && param.value !== "")
        .map((param) => `${param.key}=${param.value}`);
      
      if (queryParts.length > 0) {
        setEndpoint(`${baseUrl}?${queryParts.join("&")}`);
      } else {
        setEndpoint(baseUrl);
      }
    } catch (e) {
      // Keep original endpoint if URL parsing fails
      console.warn('Error updating endpoint with params:', e);
    }
  };

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (file) {
      setBinaryFileName(file.name);
      const reader = new FileReader();
      reader.onloadend = () => {
        setPayload(reader.result);
      };
      reader.readAsDataURL(file);
    }
  };

  const buildHeaders = () => {
    return buildAwsHeaders(endpoint, httpMethod, contentType, customContentType, headers);
  };

  // Returns true when the response is an actionable pending-authorization state
  // (e.g. AWS SSO device code), so callers can skip the "success" banner.
  // `retry` is the operation to re-run once the user has approved the device
  // code, so recovery costs a click instead of a page reload.
  const setFormattedResponse = (result, formatOptions = {}, retry = null) => {
    const formatted = formatApiResponse(result, formatOptions);
    setResponse(formatted.text);
    setResponseHtml(formatted.html);
    const authUrl = extractPendingAuthUrl(result);
    if (authUrl) setPendingAuth({ url: authUrl, retry });
    return result?.statusCode === 401;
  };

  const buildRequestBody = () => {
    if (invocationMode === "Cli") {
      return { commandPayload };
    }

    if (!payload) {
      return null;
    }

    const selectedContentTypeValue = contentType === "custom" ? customContentType : contentType;

    if (selectedContentTypeValue === "application/json" || 
        (selectedContentTypeValue && selectedContentTypeValue.toLowerCase().includes("json"))) {
      try {
        return JSON.parse(payload);
      } catch (e) {
        throw new Error("Invalid JSON payload");
      }
    }

    return payload;
  };

  const handlePresign = async () => {
    if (!selectedProfile || !selectedAuthnMechanism || !endpoint) {
      setError("Please select profile, authentication mechanism, and endpoint");
      return;
    }

    setPresigning(true);
    setProcessing(true);
    setError(null);
    setSuccess(null);
    setPendingAuth(null);
    // Clear any previous response so the "Processing…" placeholder shows alone.
    setResponse("");
    setResponseHtml(null);
    clearCurl();

    try {
      const options = {
        endpoint,
        method: httpMethod,
        profileName: selectedProfile,
        authnMode: selectedAuthnMechanism,
        headers: buildHeaders(),
        expiresInSeconds: parseInt(presignExpiry, 10)
      };
      // Send the body so the backend can sign sha256(body) for body-bearing
      // AWS query-protocol calls (e.g. EC2 DescribeInstances). Without a signed
      // body those services reject the presigned URL with AuthFailure. S3 and
      // GET presigns ignore the body server-side (UNSIGNED-PAYLOAD / empty).
      const presignBody = buildRequestBody();
      if (presignBody !== null) {
        options.body = presignBody;
      }

      const result = await presignApi.generateAuthResponse(options);
      // A body-bearing (non-GET) presigned URL isn't usable on its own, so the
      // formatter suppresses the clickable link and points at "Copy Request as
      // Curl" instead.
      const presignHasBody = presignBody !== null && httpMethod.toUpperCase() !== "GET";
      const awaitingAuth = setFormattedResponse(result, { presignHasBody }, handlePresign);
      if (!awaitingAuth) {
        setSuccess("Presigned URL generated successfully");
        // Snapshot what was presigned so "Copy as curl" can rebuild the exact,
        // self-sufficient command (presigned URL + body) shown in the response.
        const presignedUrl = extractPresignedUrl(result?.response?.preSignedUrl);
        if (presignedUrl) {
          setCurlContext({
            kind: "presign",
            method: httpMethod,
            url: presignedUrl,
            body: getBodyString(),
            contentType: selectedContentType()
          });
        }
      }
    } catch (err) {
      const errorFormatted = formatErrorResponse(err.response?.data);
      if (errorFormatted) {
        setError(null);
        setResponse(errorFormatted.text);
        setResponseHtml(errorFormatted.html);
        setPendingAuth({ url: extractPendingAuthUrl(err.response?.data), retry: handlePresign });
      } else {
        setError(err.response?.data?.message || err.message || "Failed to generate presigned URL");
        if (err.response?.data) {
          setResponse(JSON.stringify(err.response.data, null, 2));
          setResponseHtml(null);
        }
      }
    } finally {
      setPresigning(false);
      setProcessing(false);
    }
  };

  const handleInvoke = async () => {
    if (!selectedProfile || !selectedAuthnMechanism) {
      setError("Please select profile and authentication mechanism");
      return;
    }

    if (invocationMode === "Rest_Api" && !endpoint) {
      setError("Please specify endpoint");
      return;
    }

    if (invocationMode === "Cli" && !commandPayload) {
      setError("Please specify command");
      return;
    }

    setInvoking(true);
    setProcessing(true);
    setError(null);
    setSuccess(null);
    setPendingAuth(null);
    // Clear any previous response so the "Processing…" placeholder shows alone.
    setResponse("");
    setResponseHtml(null);
    clearCurl();

    try {
      const options = {
        method: httpMethod,
        profileName: selectedProfile,
        authnMode: selectedAuthnMechanism,
        headers: buildHeaders()
      };

      let awaitingAuth = false;
      if (invocationMode === "Cli") {
        options.commandPayload = commandPayload;
        const result = await presignApi.invokeCommand(options);
        awaitingAuth = setFormattedResponse(result, {}, handleInvoke);
      } else {
        options.endpoint = endpoint;
        const body = buildRequestBody();
        if (body !== null) {
          options.body = body;
        }

        let result;
        const authnModeLower = selectedAuthnMechanism.toLowerCase();
        // Every AWS mechanism — IAM keys, SSO, EC2 instance role, IRSA — goes
        // through the one SigV4 endpoint. The backend resolves the credentials
        // (credentialProvider) and the signers branch on whether a session token
        // came back, not on which mechanism produced it.
        if (isAwsMode(authnModeLower)) {
          result = await presignApi.generateAuthResponseAndInvoke(options);
        } else if (authnModeLower === "rest_basic_auth") {
          result = await presignApi.generateAuthResponseAndInvokeRestBasicAuth(options);
        } else if (authnModeLower === "rest_bearer_token") {
          result = await presignApi.generateAuthResponseAndInvokeRestBearerToken(options);
        } else if (authnModeLower === "generic") {
          result = await presignApi.generateAuthResponseAndInvokeGeneric(options);
        } else {
          throw new Error("Unsupported authentication mechanism");
        }
        awaitingAuth = setFormattedResponse(result, {}, handleInvoke);
      }
      if (!awaitingAuth) {
        setSuccess("Request executed successfully");
        // Snapshot what was invoked so "Copy as curl" can rebuild the exact,
        // self-sufficient command. CLI mode has no curl equivalent.
        if (invocationMode !== "Cli") {
          setCurlContext({
            kind: "invoke",
            method: httpMethod,
            endpoint,
            profileName: selectedProfile,
            authnMode: selectedAuthnMechanism,
            headers: buildHeaders(),
            body: getBodyString(),
            contentType: selectedContentType(),
            expiresInSeconds: parseInt(presignExpiry, 10)
          });
        }
      }
    } catch (err) {
      const errorFormatted = formatErrorResponse(err.response?.data);
      if (errorFormatted) {
        setError(null);
        setResponse(errorFormatted.text);
        setResponseHtml(errorFormatted.html);
        setPendingAuth({ url: extractPendingAuthUrl(err.response?.data), retry: handleInvoke });
      } else {
        setError(err.response?.data?.message || err.message || "Failed to execute request");
        if (err.response?.data) {
          setResponse(JSON.stringify(err.response.data, null, 2));
          setResponseHtml(null);
        }
      }
    } finally {
      setInvoking(false);
      setProcessing(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(response);
    setSuccess("Copied to clipboard");
    setTimeout(() => setSuccess(null), 3000);
  };

  const clearCurl = () => {
    setCurlContext(null);
  };

  // Body as a raw string for curl (buildRequestBody may return an object for
  // JSON content types; the wire form is the stringified body).
  const getBodyString = () => {
    const body = buildRequestBody();
    if (body == null) return null;
    if (typeof body === "object") return JSON.stringify(body);
    return String(body);
  };

  const selectedContentType = () =>
    contentType === "custom" ? customContentType : contentType;

  // Build the full curl request description for what was just run. For a presign
  // the response IS a presigned URL, so the curl is that URL + body. For an
  // invoke we ask the backend to reproduce the exact signed request (SigV4
  // headers for AWS, or the embedded Basic/Bearer credential for REST) so the
  // command runs as-is. A non-GET request always carries its body + Content-Type
  // so the command is self-sufficient. Returns { method, url, headers, body }
  // or null on error.
  const resolveCurlRequest = async () => {
    const ctx = curlContext;
    const isGet = (ctx.method || "GET").toUpperCase() === "GET";

    if (ctx.kind === "presign") {
      const headers = {};
      let body = null;
      if (!isGet) {
        body = ctx.body;
        if (ctx.contentType && ctx.contentType !== "Select Content-Type") {
          headers["Content-Type"] = ctx.contentType;
        }
      }
      return { method: ctx.method, url: ctx.url, headers, body };
    }

    const options = {
      endpoint: ctx.endpoint,
      method: ctx.method,
      profileName: ctx.profileName,
      authnMode: ctx.authnMode,
      headers: ctx.headers
    };
    if (ctx.body != null) {
      options.body = ctx.body;
    }
    const result = await presignApi.prepareCurlRequest(options);
    const data = result?.response;
    if (result?.statusCode !== 200 || !data || !data.url) {
      if (data?.verificationUriComplete) {
        // Same treatment as an invoke: Authorize opens the device page, Retry
        // rebuilds the curl command once it has been approved.
        setPendingAuth({ url: data.verificationUriComplete, retry: copyRequestAsCurl });
      } else {
        setError(data?.message || "Could not prepare the curl command");
      }
      return null;
    }
    return { method: data.method, url: data.url, headers: data.headers, body: data.body };
  };

  // "Copy Request as Curl": build the complete command and put it straight on
  // the clipboard (nothing rendered on screen), like "Copy Response".
  const copyRequestAsCurl = async () => {
    if (!curlContext) return;
    setCurlBusy(true);
    setError(null);
    setPendingAuth(null);
    try {
      const request = await resolveCurlRequest();
      if (!request) return;
      navigator.clipboard.writeText(buildCurlCommand(request));
      setSuccess("Request copied as curl to clipboard");
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to build curl command");
    } finally {
      setCurlBusy(false);
    }
  };

  const updateHeader = (index, field, value) => {
    const newHeaders = [...headers];
    newHeaders[index][field] = value;
    setHeaders(newHeaders);
  };

  return (
    <Container
      header={
        <Header variant="h1" description="Invoke AWS and REST API APIs">
          SignBridge Dashboard
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && (
          <Alert type="error" dismissible onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}
        {/* An SSO device authorization waiting on the user. Authorize opens the
            approval page in a new tab; Retry re-runs the request that triggered
            it, so approving no longer means reloading the page and refilling the
            form. This is Cloudscape rather than the shared Bootstrap
            ApiErrorAlert on purpose — mixing the two design systems on one
            screen looks like a defect. */}
        {pendingAuth && (
          <Alert
            type="warning"
            header="This AWS SSO session needs approval"
            dismissible
            onDismiss={() => setPendingAuth(null)}
            action={
              <SpaceBetween direction="horizontal" size="xs">
                {pendingAuth.url && (
                  <Button href={pendingAuth.url} target="_blank" iconAlign="right" iconName="external">
                    Authorize this SSO session
                  </Button>
                )}
                {pendingAuth.retry && (
                  <Button
                    variant="primary"
                    iconName="refresh"
                    loading={presigning || invoking || curlBusy}
                    onClick={() => {
                      setPendingAuth(null);
                      pendingAuth.retry();
                    }}
                  >
                    Retry
                  </Button>
                )}
              </SpaceBetween>
            }
          >
            Approve the device code in the new tab, then Retry — no need to reload this page.
          </Alert>
        )}
        {success && (
          <Alert type="success" dismissible onDismiss={() => setSuccess(null)}>
            {success}
          </Alert>
        )}

        <FormField label="Available Profiles">
          <Select
            selectedOption={profiles.find((p) => p.value === selectedProfile) || profiles[0]}
            onChange={({ detail }) => setSelectedProfile(detail.selectedOption.value)}
            options={profiles}
            placeholder="Select Profile"
          />
        </FormField>

        {selectedProfile && (
          <FormField label="Available Authentication Mechanism">
            <Select
              selectedOption={
                authnMechanisms.find((a) => a.value === selectedAuthnMechanism) || authnMechanisms[0]
              }
              onChange={({ detail }) => setSelectedAuthnMechanism(detail.selectedOption.value)}
              options={authnMechanisms}
              placeholder="Select Authentication Mechanism"
            />
          </FormField>
        )}

        <ExpandableSection
          headerText={`Invocation Mode: ${
            (invocationModes.find((m) => m.value === invocationMode) || {}).label || invocationMode
          }`}
        >
          <RadioGroup
            value={invocationMode}
            items={invocationModes.map((m) => ({ value: m.value, label: m.label }))}
            onChange={({ detail }) => setInvocationMode(detail.value)}
          />
        </ExpandableSection>

        {isSandbox ? (
          <Suspense fallback={<Box padding="l" textAlign="center"><Spinner /> Loading editor…</Box>}>
            <SandboxIde
              embedded
              profileName={selectedProfile}
              authnMode={selectedAuthnMechanism}
            />
          </Suspense>
        ) : invocationMode === "Cli" ? (
          <FormField label="Command">
            <Textarea
              value={commandPayload}
              onChange={({ detail }) => setCommandPayload(detail.value)}
              rows={5}
              placeholder="Enter AWS CLI command"
            />
          </FormField>
        ) : (
          <>
            <ExpandableSection headerText={`HTTP Method: ${httpMethod}`}>
              <RadioGroup
                value={httpMethod}
                items={httpMethods.map((m) => ({ value: m.value, label: m.label }))}
                onChange={({ detail }) => setHttpMethod(detail.value)}
              />
            </ExpandableSection>

            <FormField label="Endpoint" description="Full URL including protocol">
              <Input
                value={endpoint}
                onChange={({ detail }) => setEndpoint(detail.value)}
                placeholder="https://example.com/api/endpoint"
              />
            </FormField>

            <FormField label="Content-Type">
              <Select
                selectedOption={contentTypes.find((c) => c.value === contentType) || contentTypes[0]}
                onChange={({ detail }) => {
                  setContentType(detail.selectedOption.value);
                  if (detail.selectedOption.value !== "custom") {
                    setCustomContentType("");
                  }
                }}
                options={contentTypes}
              />
            </FormField>

            {contentType === "custom" && (
              <FormField label="Specify Custom Content-Type">
                <Input
                  value={customContentType}
                  onChange={({ detail }) => setCustomContentType(detail.value)}
                  placeholder="application/xml"
                />
              </FormField>
            )}

            <ExpandableSection headerText={`Payload Type: ${payloadType === "binary" ? "Binary" : "Raw"}`}>
              <RadioGroup
                value={payloadType}
                items={[
                  { value: "raw", label: "Raw" },
                  { value: "binary", label: "Binary" }
                ]}
                onChange={({ detail }) => setPayloadType(detail.value)}
              />
            </ExpandableSection>

            <ExpandableSection
              headerText="Payload"
              headerDescription="Expand to add a request body; kept collapsed so the response stays in view."
            >
              {payloadType === "raw" ? (
                <FormField label="Payload">
                  <Textarea
                    value={payload}
                    onChange={({ detail }) => setPayload(detail.value)}
                    rows={8}
                    placeholder='{"key": "value"}'
                  />
                </FormField>
              ) : (
                <FormField label="Upload Binary File">
                  <input type="file" onChange={handleFileUpload} />
                  {binaryFileName && <Box margin={{ top: "xs" }}>Selected: {binaryFileName}</Box>}
                </FormField>
              )}
            </ExpandableSection>

            <ExpandableSection headerText="Query Parameters">
              <SpaceBetween size="s">
                {queryParams.length > 0 && (
                  <Table
                    columnDefinitions={[
                      { id: "key", header: "Key", cell: (item) => item.key },
                      { id: "value", header: "Value", cell: (item) => item.value },
                      {
                        id: "actions",
                        header: "Actions",
                        cell: (item, rowIndex) => (
                          <Button onClick={() => removeQueryParam(rowIndex)}>Remove</Button>
                        )
                      }
                    ]}
                    items={queryParams}
                  />
                )}
                <SpaceBetween direction="horizontal" size="s">
                  <Input
                    value={queryParamKey}
                    onChange={({ detail }) => setQueryParamKey(detail.value)}
                    placeholder="Key"
                  />
                  <Input
                    value={queryParamValue}
                    onChange={({ detail }) => setQueryParamValue(detail.value)}
                    placeholder="Value"
                  />
                  <Button onClick={addQueryParam}>Add</Button>
                </SpaceBetween>
              </SpaceBetween>
            </ExpandableSection>

            <ExpandableSection headerText="Additional Headers">
              <SpaceBetween size="s">
                {headers.map((header, index) => (
                  <SpaceBetween key={index} direction="horizontal" size="s">
                    <Input
                      value={header.key}
                      onChange={({ detail }) => updateHeader(index, "key", detail.value)}
                      placeholder="Header Key"
                    />
                    <Input
                      value={header.value}
                      onChange={({ detail }) => updateHeader(index, "value", detail.value)}
                      placeholder="Header Value"
                    />
                  </SpaceBetween>
                ))}
                <Box variant="small" color="text-body-secondary">
                  Note: Do NOT add Authorization header for Non-Generic profiles. It's auto-generated.
                </Box>
              </SpaceBetween>
            </ExpandableSection>
          </>
        )}

        {invocationMode === "Rest_Api" && (
          <FormField
            label="Presigned URL Expiry"
            description="How long the presigned URL stays valid. For AWS SSO profiles it is automatically capped to the SSO session's remaining life. Applies to Presign only, not Invoke."
          >
            <Select
              selectedOption={
                presignExpiryOptions.find((o) => o.value === presignExpiry) || presignExpiryOptions[2]
              }
              onChange={({ detail }) => setPresignExpiry(detail.selectedOption.value)}
              options={presignExpiryOptions}
            />
          </FormField>
        )}

        {!isSandbox && (() => {
          const busy = presigning || invoking || curlBusy;
          return (
            <SpaceBetween direction="horizontal" size="s">
              {invocationMode === "Rest_Api" && (
                <Button onClick={handlePresign} loading={presigning} disabled={busy}>
                  Presign
                </Button>
              )}
              <Button
                onClick={handleInvoke}
                loading={invoking}
                disabled={busy}
                variant="primary"
              >
                {invocationMode === "Cli" ? "Execute" : "Invoke"}
              </Button>
              <Button
                onClick={() => { setResponse(""); setResponseHtml(null); clearCurl(); }}
                disabled={busy}
              >
                Clear Response
              </Button>
            </SpaceBetween>
          );
        })()}

        {!isSandbox && processing && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "14px 16px",
              border: "1px solid #b6d7ff",
              borderRadius: "6px",
              background: "#f0f7ff",
              color: "#0972d3",
              fontWeight: 600
            }}
          >
            <Spinner size="large" />
            <span>Processing your request. Please wait…</span>
          </div>
        )}

        {!isSandbox && !processing && (response || responseHtml) && (
          <ExpandableSection headerText="Response" defaultExpanded>
            <SpaceBetween size="s">
              {/* Copy actions for the request that produced this response.
                  "Copy Request as Curl" appears only once a request has actually
                  run, and copies a complete, self-sufficient command (body
                  included for non-GET) straight to the clipboard. */}
              <SpaceBetween direction="horizontal" size="s">
                <Button iconName="copy" onClick={copyToClipboard}>Copy Response</Button>
                {curlContext && (
                  <Button iconName="copy" onClick={copyRequestAsCurl} loading={curlBusy}>
                    Copy Request as Curl
                  </Button>
                )}
              </SpaceBetween>
              <Box>
                {responseHtml ? (
                  <div
                    className="border p-3 bg-white"
                    dangerouslySetInnerHTML={{ __html: responseHtml }}
                  />
                ) : null}
                {response ? (
                  <pre style={{ overflow: "auto", maxHeight: "600px", border: "1px solid #ccc", padding: "10px" }}>
                    {response}
                  </pre>
                ) : null}
              </Box>
            </SpaceBetween>
          </ExpandableSection>
        )}
      </SpaceBetween>
    </Container>
  );
}

export default PresignDashboard;
