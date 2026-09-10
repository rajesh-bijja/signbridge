import React, { useState, useEffect, useRef } from "react";
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
  Textarea,
  ExpandableSection,
  Select
} from "@cloudscape-design/components";
import * as presignApi from "./presignApi";
import { useConfirm } from "./ConfirmDialog";
import { getSocket, getUserName } from "./presignSocket";
import { appPath } from "../appConfig";

function PresignTemplates() {
  const { confirm, confirmDialog } = useConfirm();
  const [collections, setCollections] = useState([]);
  const [selectedCollection, setSelectedCollection] = useState(null);
  // Multi-select: the checked request rows. Details are only shown when exactly
  // one is selected; with more than one, only the bulk delete action is offered.
  const [selectedItems, setSelectedItems] = useState([]);
  const [collectionName, setCollectionName] = useState("");
  // Delete Collection: the collection the user picked to delete (a Select option
  // whose value is the imported (timestamped) collection name the backend keys on).
  const [selectedDeleteCollection, setSelectedDeleteCollection] = useState(null);
  // Confirmation-prompt settings (default to prompting when unset).
  const [promptCollectionDeletion, setPromptCollectionDeletion] = useState(true);
  const [promptCollectionRequestDeletion, setPromptCollectionRequestDeletion] = useState(true);
  const [collectionFile, setCollectionFile] = useState(null);
  const [collectionContent, setCollectionContent] = useState("");
  const [specifyCollection, setSpecifyCollection] = useState(false);
  const [importFromAws, setImportFromAws] = useState(false);
  const [awsCatalog, setAwsCatalog] = useState([]);
  const [selectedAwsService, setSelectedAwsService] = useState(null);
  const [awsImporting, setAwsImporting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [deleteCollection, setDeleteCollection] = useState(false);
  // Two-level table filter: narrow to a collection first, then find a request
  // within it by name or label.
  const [collectionFilter, setCollectionFilter] = useState("");
  const [requestFilter, setRequestFilter] = useState("");
  const [leftWidth, setLeftWidth] = useState(50); // percent width of the left panel
  const [requestDetails, setRequestDetails] = useState(null);
  // Pin-to-Dashboard profile selection. Imported requests carry no profile, so
  // the user must pick one (and which auth mode to sign/invoke with) inline
  // before pinning.
  const [profileOptions, setProfileOptions] = useState([]);
  const [selectedPinProfile, setSelectedPinProfile] = useState(null);
  const [selectedPinAuthnMode, setSelectedPinAuthnMode] = useState(null);
  const [pinProfilesRaw, setPinProfilesRaw] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const socketRef = useRef(null);
  const selectedCollectionIdRef = useRef(null);
  const splitContainerRef = useRef(null);
  const isDraggingSplitterRef = useRef(false);

  useEffect(() => {
    loadCollections();
    loadAwsCatalog();
    loadProfilesForPin();
    loadDeletePrompts();

    // Initialize socket connection
    const socket = getSocket();
    socketRef.current = socket;
    const userName = getUserName();
    const displayCollectionProgressEvent = 'event_display_collection_details_' + userName;
    
    // Listen for collection details
    socket.on(displayCollectionProgressEvent, (obj) => {
      if (selectedCollectionIdRef.current === obj.collectionId) {
        const overallTextJsonObj = obj.data;
        if (overallTextJsonObj) {
          setRequestDetails({
            requestName: overallTextJsonObj.requestName || "",
            endpoint: overallTextJsonObj.endpoint || "",
            method: overallTextJsonObj.method || "",
            requestAuthType: overallTextJsonObj.requestAuthType || "",
            header: overallTextJsonObj.header || {},
            body: overallTextJsonObj.body || "",
            requestLabel: overallTextJsonObj.requestLabel || "Not Specified",
            collectionName: overallTextJsonObj.collectionName || "",
            importedCollectionName: overallTextJsonObj.importedCollectionName || "",
            addedAt: overallTextJsonObj.addedAt || ""
          });
          // Update selected collection with full details
          setSelectedCollection(prev => ({
            ...prev,
            ...overallTextJsonObj
          }));
        } else {
          setError("Failed to load collection details");
        }
        setLoading(false);
      }
    });
    
    return () => {
      // Cleanup: remove socket listener on unmount
      socket.off(displayCollectionProgressEvent);
    };
  }, []);

  // Load the collection/request deletion confirmation settings. Default to
  // prompting (true) when a value is absent, so a missing setting never silently
  // disables the confirmation dialog.
  const loadDeletePrompts = async () => {
    try {
      const settings = await presignApi.populateSettingsDetails();
      setPromptCollectionDeletion(settings?.shouldPromptCollectionDeletion ?? true);
      setPromptCollectionRequestDeletion(settings?.shouldPromptCollectionRequestDeletion ?? true);
    } catch {
      // On failure, keep the safe defaults (prompt before deleting).
    }
  };

  const loadCollections = async (label = null) => {
    try {
      const data = await presignApi.populateCollectionsDetails(label);
      if (data && data.length > 0) {
        const formattedData = data.map((item, index) => ({
          id: index + 1,
          collectionId: item.requestDetailsFileName?.replace(".json", "") || "",
          method: item.method || "",
          collectionName: item.collectionName || "",
          requestName: item.requestName || "",
          requestLabel: item.requestLabel || "Not Specified",
          ...item
        }));
        setCollections(formattedData);
      } else {
        setCollections([]);
      }
    } catch (err) {
      setError("Failed to load collections: " + err.message);
    }
  };

  const readCollectionFile = (file) => {
    if (!file) return;
    setCollectionFile(file);
    setCollectionName(file.name);
    const reader = new FileReader();
    reader.onloadend = () => {
      setCollectionContent(reader.result);
    };
    reader.readAsText(file);
  };

  const handleFileSelect = (event) => {
    readCollectionFile(event.target.files[0]);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) {
      readCollectionFile(file);
    }
  };

  const handleImport = async () => {
    if (!collectionContent) {
      setError("Please select, drop, or paste a collection to import");
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const payload = JSON.parse(collectionContent);
      await presignApi.importCollection(collectionName, payload);
      setSuccess(`Collection ${collectionName} imported successfully`);
      setCollectionFile(null);
      setCollectionName("");
      setCollectionContent("");
      setSpecifyCollection(false);
      loadCollections();
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to import collection");
    } finally {
      setLoading(false);
    }
  };

  const loadAwsCatalog = async () => {
    try {
      const data = await presignApi.listAwsCatalog();
      setAwsCatalog(data?.services || []);
    } catch (err) {
      // Catalog is optional — if it hasn't been built, just leave the picker empty.
      console.warn("AWS catalog not available:", err.message);
      setAwsCatalog([]);
    }
  };

  const handleImportAwsService = async () => {
    if (!selectedAwsService) {
      setError("Please select an AWS service to import");
      return;
    }

    setAwsImporting(true);
    setError(null);
    setSuccess(null);

    try {
      // The backend builds the collection on demand from the botocore model and
      // imports it — the client only sends the service name.
      const result = await presignApi.importAwsCatalogService(selectedAwsService.value);
      const label = selectedAwsService.label || selectedAwsService.value;
      const count = result?.requestCount != null ? `${result.requestCount} ` : "";
      setSuccess(`Imported ${count}${label} request(s)`);
      setSelectedAwsService(null);
      setImportFromAws(false);
      loadCollections();
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to import AWS service");
    } finally {
      setAwsImporting(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedDeleteCollection) {
      setError("Please choose a collection to delete");
      return;
    }

    // The Select's label is the human-friendly collection name; its value is the
    // imported (timestamped) name the backend deletes by.
    const importedName = selectedDeleteCollection.value;
    const displayName = selectedDeleteCollection.label || importedName;

    if (promptCollectionDeletion) {
      const confirmed = await confirm({
        title: "Delete collection",
        message: `Delete collection "${displayName}" and all of its imported requests? Requests already saved in History or Favorites are not affected.`
      });
      if (!confirmed) {
        return;
      }
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      await presignApi.deleteCollection(importedName);
      setSuccess(`Collection "${displayName}" deleted successfully`);
      setSelectedDeleteCollection(null);
      setDeleteCollection(false);
      setSelectedItems([]);
      setSelectedCollection(null);
      setRequestDetails(null);
      loadCollections();
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to delete collection");
    } finally {
      setLoading(false);
    }
  };

  // Delete the selected request(s) from their collection. Copies already saved
  // in History/Favorites are unaffected (separate storage). Honors the
  // "Prompt Request Deletion in a Collection" setting.
  const handleDeleteRequests = async () => {
    if (selectedItems.length === 0) {
      setError("Please select one or more requests to delete");
      return;
    }

    if (promptCollectionRequestDeletion) {
      const count = selectedItems.length;
      const confirmed = await confirm({
        title: "Delete request from collection",
        message:
          count === 1
            ? "Delete this request from its collection? Copies already saved in History or Favorites are not affected."
            : `Delete these ${count} requests from their collection? Copies already saved in History or Favorites are not affected.`
      });
      if (!confirmed) {
        return;
      }
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      // Delete each selected request; collect failures for partial-success reporting.
      const failures = [];
      for (const item of selectedItems) {
        const fileName = item.requestDetailsFileName;
        if (!fileName) {
          failures.push(item.requestName || item.id);
          continue;
        }
        try {
          await presignApi.deleteRequestFromCollection(fileName);
        } catch (err) {
          failures.push(item.requestName || item.id);
        }
      }
      const deleted = selectedItems.length - failures.length;
      if (failures.length === 0) {
        setSuccess(`Deleted ${deleted} ${deleted === 1 ? "request" : "requests"} from the collection`);
      } else {
        setError(`Deleted ${deleted}, failed to delete ${failures.length} (${failures.join(", ")})`);
      }
      setSelectedItems([]);
      setSelectedCollection(null);
      setRequestDetails(null);
      selectedCollectionIdRef.current = null;
      loadCollections();
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to delete request(s)");
    } finally {
      setLoading(false);
    }
  };

  // Distinct imported collections available to delete. Keyed by the imported
  // (timestamped) name the backend deletes by; labelled with the friendly
  // collection name (falling back to the imported name).
  const deleteCollectionOptions = React.useMemo(() => {
    const byImportedName = new Map();
    collections.forEach((item) => {
      const importedName = item.importedCollectionName;
      if (!importedName || byImportedName.has(importedName)) return;
      byImportedName.set(importedName, {
        value: importedName,
        label: item.collectionName || importedName
      });
    });
    return Array.from(byImportedName.values()).sort((a, b) =>
      a.label.localeCompare(b.label)
    );
  }, [collections]);

  // Distinct collection names present in the loaded requests, for the
  // collection-level filter dropdown.
  const collectionOptions = React.useMemo(() => {
    const names = new Set();
    collections.forEach((item) => {
      if (item.collectionName) names.add(item.collectionName);
    });
    const opts = Array.from(names)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ value: name, label: name }));
    return [{ value: "", label: "All collections" }, ...opts];
  }, [collections]);

  // Two-level client-side filter: first narrow by collection name, then match a
  // specific request within it by request name or label (case-insensitive).
  const filteredCollections = React.useMemo(() => {
    const col = collectionFilter.trim().toLowerCase();
    const req = requestFilter.trim().toLowerCase();
    return collections.filter((item) => {
      if (col && (item.collectionName || "").toLowerCase() !== col) {
        return false;
      }
      if (req) {
        const haystack = [item.requestName, item.requestLabel]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(req)) return false;
      }
      return true;
    });
  }, [collections, collectionFilter, requestFilter]);

  // Draggable splitter between the request list (left) and details (right).
  const startSplitterDrag = (e) => {
    e.preventDefault();
    isDraggingSplitterRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  useEffect(() => {
    const onMove = (e) => {
      if (!isDraggingSplitterRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      // Clamp so neither panel collapses entirely.
      setLeftWidth(Math.min(80, Math.max(20, pct)));
    };
    const onUp = () => {
      if (!isDraggingSplitterRef.current) return;
      isDraggingSplitterRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const handleRowClick = (item) => {
    if (!item) return;
    setSelectedItems([item]);
    setSelectedCollection(item);
    selectedCollectionIdRef.current = item.collectionId;
    setLoading(true);
    setError(null);
    setRequestDetails({
      requestName: "Loading...",
      endpoint: "Loading...",
      method: item.method || "",
      requestAuthType: "Loading...",
      header: {},
      body: "",
      requestLabel: item.requestLabel || "Not Specified"
    });
    
    // Emit socket event to fetch details (following SignBridge pattern)
    const socket = socketRef.current;
    if (socket && item.collectionId) {
      const userName = getUserName();
      const eventObj = {
        collectionId: item.collectionId,
        userName: userName
      };
      socket.emit('event_get_collection_id_log', eventObj);
    } else {
      // Fallback to item data if no collectionId
      setRequestDetails({
        requestName: item.requestName || item.name || "",
        endpoint: item.endpoint || item.url || "",
        method: item.method || "",
        requestAuthType: item.requestAuthType || item.authType || "",
        header: item.header || item.headers || {},
        body: item.body || item.data || "",
        requestLabel: item.requestLabel || "Not Specified"
      });
      setLoading(false);
    }
  };

  // Multi-select handler for the request table. Details are shown only when a
  // single request is selected; with more than one, the right panel offers only
  // the bulk Delete Request action.
  const handleSelectionChange = (items) => {
    setSelectedItems(items);
    if (items.length === 1) {
      handleRowClick(items[0]);
    } else {
      setSelectedCollection(null);
      setRequestDetails(null);
      selectedCollectionIdRef.current = null;
    }
  };

  // Load the user's profiles once, for the inline Pin-to-Dashboard selectors.
  const loadProfilesForPin = async () => {
    try {
      const data = await presignApi.populateProfilesDetails();
      const profiles = data || [];
      setPinProfilesRaw(profiles);
      setProfileOptions(
        profiles.map((p) => ({ value: p.profileName, label: p.profileName }))
      );
    } catch (err) {
      console.warn("Failed to load profiles for pinning:", err.message);
      setPinProfilesRaw([]);
      setProfileOptions([]);
    }
  };

  // Auth mechanisms supported by the profile currently chosen inline.
  const pinAuthnModeOptions = React.useMemo(() => {
    if (!selectedPinProfile) return [];
    const profile = pinProfilesRaw.find((p) => p.profileName === selectedPinProfile.value);
    const mechanisms = (profile && profile.supportedAuthnMechanisms) || [];
    return mechanisms.map((m) => ({ value: m, label: m }));
  }, [selectedPinProfile, pinProfilesRaw]);

  // Normalize a stored header collection into a plain { key: value } map.
  // Imported requests store headers as an array of { key, value } objects; some
  // paths may store an object or a JSON string. Handle all three.
  const headersToMap = (headerData) => {
    const map = {};
    if (!headerData) return map;
    if (typeof headerData === "string") {
      try {
        headerData = JSON.parse(headerData);
      } catch (e) {
        return map;
      }
    }
    if (Array.isArray(headerData)) {
      headerData.forEach((h) => {
        if (h && h.key) map[h.key] = h.value;
      });
    } else if (typeof headerData === "object") {
      Object.keys(headerData).forEach((key) => {
        map[key] = headerData[key];
      });
    }
    return map;
  };

  // Map a raw Content-Type header value to the Dashboard's content-type control.
  // The control offers a fixed set of options and a "custom" escape hatch. We
  // normalize on the media type (ignoring charset/casing) so e.g.
  // "application/x-www-form-urlencoded" (no charset) still selects the built-in
  // "application/x-www-form-urlencoded; charset=utf-8" option.
  const resolveContentType = (headerContentType) => {
    const defaultContentTypes = [
      "application/json",
      "text/html",
      "application/x-www-form-urlencoded; charset=utf-8"
    ];
    if (!headerContentType) {
      return { contentType: "application/json", customContentType: "" };
    }
    // Exact match first.
    if (defaultContentTypes.includes(headerContentType)) {
      return { contentType: headerContentType, customContentType: "" };
    }
    // Match on media type alone (strip charset/params, lower-case).
    const mediaType = headerContentType.split(";")[0].trim().toLowerCase();
    const matched = defaultContentTypes.find(
      (ct) => ct.split(";")[0].trim().toLowerCase() === mediaType
    );
    if (matched) {
      return { contentType: matched, customContentType: "" };
    }
    return { contentType: "custom", customContentType: headerContentType };
  };

  // Pin the selected request to the Dashboard using the inline-selected profile
  // and auth mode. An imported request has no profile (Request Auth Type isn't a
  // real profile), so both must be chosen first.
  const handlePinToDashboard = async () => {
    if (!selectedCollection || !requestDetails) {
      setError("Please select a request to pin");
      return;
    }
    if (!selectedPinProfile) {
      setError("Please select a profile");
      return;
    }
    const authnMechanism = selectedPinAuthnMode
      ? selectedPinAuthnMode.value
      : (pinAuthnModeOptions[0] && pinAuthnModeOptions[0].value) || "";
    if (!authnMechanism) {
      setError("Please select an authentication mode");
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      // Get endpoint and extract query parameters
      const endpointFull = requestDetails.endpoint || selectedCollection.endpoint || "";
      let endpointBase = endpointFull;
      let queryParams = [];

      if (endpointBase && endpointBase.includes("?")) {
        try {
          const url = new URL(endpointBase);
          endpointBase = url.origin + url.pathname;
          url.searchParams.forEach((value, key) => {
            queryParams.push({ key, value });
          });
        } catch (e) {
          // If URL parsing fails, keep endpoint as is
          console.warn('Could not parse endpoint URL:', e);
        }
      }

      // Process payload
      let processedPayload = "";
      const bodyData = requestDetails.body || selectedCollection.body || "";
      if (bodyData) {
        if (typeof bodyData === 'string') {
          processedPayload = bodyData;
        } else if (typeof bodyData === 'object') {
          processedPayload = JSON.stringify(bodyData);
        } else {
          processedPayload = String(bodyData);
        }
      }

      // Process headers (handles array-of-{key,value}, object, or JSON string).
      const processedHeaders = headersToMap(requestDetails.header || selectedCollection.header);

      // Determine content type from headers (media-type match, charset-agnostic).
      const headerContentType = processedHeaders['Content-Type'] || processedHeaders['content-type'];
      const { contentType, customContentType } = resolveContentType(headerContentType);

      // Prepare pinned data with the user-selected profile + auth mechanism.
      const pinnedData = {
        profileName: selectedPinProfile.value,
        authnMechanism: authnMechanism,
        invocationMode: "Rest_Api",
        httpMethod: requestDetails.method || selectedCollection.method || "GET",
        endpoint: endpointBase, // Base endpoint without query params
        payload: processedPayload,
        commandPayload: "",
        headers: processedHeaders,
        contentType: contentType,
        customContentType: customContentType,
        queryParams: queryParams
      };

      // Confirm the chosen profile actually supports the chosen mechanism.
      try {
        await presignApi.checkProfileExists(pinnedData.profileName, pinnedData.authnMechanism);
      } catch (err) {
        setError("Profile does not exist: " + (err.response?.data?.message || err.message));
        setLoading(false);
        return;
      }

      // Store in localStorage (for profile selection) and sessionStorage (for other fields)
      localStorage.setItem('signBridgePinnedRequest', JSON.stringify(pinnedData));
      sessionStorage.setItem('signBridgePinnedDataToApply', JSON.stringify(pinnedData));

      setSuccess("Request pinned to dashboard. Navigate to Dashboard to see it.");

      // Navigate to dashboard after a short delay
      setTimeout(() => {
        window.location.href = appPath("/dashboard");
      }, 1000);
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to pin request to dashboard");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <Container
        header={
          <Header variant="h1" description="Import and manage Postman collections">
            SignBridge Templates
          </Header>
        }
      >
        <SpaceBetween size="m">
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

          <SpaceBetween size="m">
          <Checkbox
            checked={importFromAws}
            onChange={({ detail }) => {
              setImportFromAws(detail.checked);
              if (!detail.checked) {
                setSelectedAwsService(null);
              }
            }}
          >
            Import from AWS catalog
          </Checkbox>

          {importFromAws && (
            <Box>
              <SpaceBetween size="s">
                <Box color="text-body-secondary" fontSize="body-s">
                  Ready-made collections for common AWS services, generated from the
                  open botocore API models. Pick a service and import — no file needed.
                </Box>
                {awsCatalog.length === 0 ? (
                  <Alert type="info">
                    The AWS service list is unavailable. Check the server logs.
                  </Alert>
                ) : (
                  <SpaceBetween direction="horizontal" size="s">
                    <FormField label="AWS Service" description={`${awsCatalog.length} services available`}>
                      <Select
                        selectedOption={selectedAwsService}
                        onChange={({ detail }) => setSelectedAwsService(detail.selectedOption)}
                        options={awsCatalog.map((s) => ({
                          value: s.service,
                          label: s.label,
                          description: `API ${s.apiVersion}`
                        }))}
                        placeholder="Choose a service"
                        filteringType="auto"
                        virtualScroll
                      />
                    </FormField>
                    <Button
                      onClick={handleImportAwsService}
                      loading={awsImporting}
                      disabled={!selectedAwsService}
                    >
                      Import Service
                    </Button>
                  </SpaceBetween>
                )}
              </SpaceBetween>
            </Box>
          )}

          <Checkbox
            checked={specifyCollection}
            onChange={({ detail }) => {
              setSpecifyCollection(detail.checked);
              if (!detail.checked) {
                setCollectionFile(null);
                setCollectionName("");
                setCollectionContent("");
              }
            }}
          >
            Specify Collection
          </Checkbox>

          {specifyCollection && (
            <Box>
              <SpaceBetween size="s">
                <FormField label="Import Collection File">
                  <div
                    onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={handleDrop}
                    style={{
                      border: `2px dashed ${isDragging ? "#0972d3" : "#b6bec9"}`,
                      borderRadius: "8px",
                      padding: "20px",
                      textAlign: "center",
                      background: isDragging ? "#f0f7ff" : "#fafbfc",
                      transition: "background 0.15s, border-color 0.15s"
                    }}
                  >
                    <div style={{ marginBottom: "8px", color: "#5f6b7a" }}>
                      Drag &amp; drop a Postman collection <code>.json</code> here, or choose a file:
                    </div>
                    <input type="file" accept=".json,.JSON" onChange={handleFileSelect} />
                    {collectionName && <Box margin={{ top: "xs" }}>Selected: {collectionName}</Box>}
                  </div>
                </FormField>
                <FormField label="Or paste collection JSON">
                  <Textarea
                    value={collectionContent}
                    onChange={({ detail }) => {
                      setCollectionContent(detail.value);
                      if (!collectionName) setCollectionName("pasted-collection.json");
                      setCollectionFile(detail.value ? { name: collectionName || "pasted-collection.json" } : null);
                    }}
                    placeholder='{ "info": { "name": "..." }, "item": [ ... ] }'
                    rows={6}
                  />
                </FormField>
                <Button onClick={handleImport} loading={loading} disabled={!collectionContent}>
                  Import Collection
                </Button>
              </SpaceBetween>
            </Box>
          )}

          <Checkbox
            checked={deleteCollection}
            onChange={({ detail }) => {
              setDeleteCollection(detail.checked);
              if (!detail.checked) {
                setSelectedDeleteCollection(null);
              }
            }}
          >
            Delete Collection
          </Checkbox>

          {deleteCollection && (
            <Box>
              <SpaceBetween size="s">
                <SpaceBetween direction="horizontal" size="s">
                  <FormField label="Collection" description={`${deleteCollectionOptions.length} collection(s) available`}>
                    <Select
                      selectedOption={selectedDeleteCollection}
                      onChange={({ detail }) => setSelectedDeleteCollection(detail.selectedOption)}
                      options={deleteCollectionOptions}
                      filteringType="auto"
                      placeholder={deleteCollectionOptions.length ? "Choose a collection to delete" : "No collections imported"}
                      empty="No collections imported yet"
                    />
                  </FormField>
                  <Button onClick={handleDelete} loading={loading} disabled={!selectedDeleteCollection}>
                    Delete Collection
                  </Button>
                </SpaceBetween>
                <Box color="text-body-secondary" fontSize="body-s">
                  Deletes the collection and all of its imported requests. Requests
                  already saved in History or Favorites are not affected.
                </Box>
              </SpaceBetween>
            </Box>
          )}
          </SpaceBetween>
        </SpaceBetween>
      </Container>

      {/* Split Layout Container */}
      <div
        ref={splitContainerRef}
        style={{
          display: "flex",
          flex: "1",
          padding: "20px",
          overflow: "hidden",
          minHeight: 0
        }}
      >
        {/* Left Panel - Scrollable List */}
        <div style={{
          flexBasis: `${leftWidth}%`,
          flexGrow: 0,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          border: "1px solid #d1d5db",
          borderRadius: "4px",
          backgroundColor: "#fff"
        }}>
          <div style={{ flex: "1", overflowY: "auto", overflowX: "auto", minHeight: 0 }}>
            <Table
                columnDefinitions={[
                  { id: "id", header: "#", cell: (item) => item.id, width: "50px" },
                  { id: "method", header: "Method", cell: (item) => item.method, width: "90px" },
                  { id: "collectionName", header: "Collection", cell: (item) => item.collectionName || "—" },
                  { id: "requestName", header: "Request Name", cell: (item) => item.requestName },
                  { id: "requestLabel", header: "Request Label", cell: (item) => item.requestLabel }
                ]}
                items={filteredCollections}
                trackBy="collectionId"
                onRowClick={({ detail }) => handleRowClick(detail.item)}
                onSelectionChange={({ detail }) => handleSelectionChange(detail.selectedItems)}
                selectedItems={selectedItems}
                selectionType="multi"
                stickyHeader
                filter={
                  <SpaceBetween size="xs">
                    <Select
                      selectedOption={
                        collectionOptions.find((o) => o.value === collectionFilter) || collectionOptions[0]
                      }
                      onChange={({ detail }) => setCollectionFilter(detail.selectedOption.value || "")}
                      options={collectionOptions}
                      filteringType="auto"
                      placeholder="Filter by collection"
                    />
                    <Input
                      type="search"
                      value={requestFilter}
                      onChange={({ detail }) => setRequestFilter(detail.value)}
                      placeholder="Find a request by name or label"
                      clearAriaLabel="Clear"
                    />
                  </SpaceBetween>
                }
                counter={`(${filteredCollections.length})`}
                empty={
                  <Box textAlign="center" color="text-body-secondary" padding="m">
                    {collections.length === 0 ? "No requests imported yet" : "No requests match your search"}
                  </Box>
                }
              />
          </div>
        </div>

        {/* Draggable splitter */}
        <div
          onMouseDown={startSplitterDrag}
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize"
          style={{
            flex: "0 0 10px",
            cursor: "col-resize",
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
          }}
        >
          <div style={{ width: "2px", height: "40px", background: "#b6bec9", borderRadius: "1px" }} />
        </div>

        {/* Right Panel - Details */}
        <div style={{
          flexBasis: `${100 - leftWidth}%`,
          flexGrow: 1,
          flexShrink: 1,
          overflowY: "auto",
          overflowX: "hidden",
          padding: "16px",
          border: "1px solid #d1d5db",
          borderRadius: "4px",
          backgroundColor: "#fff"
        }}>
            {selectedItems.length > 1 ? (
              <SpaceBetween size="m">
                <Box>
                  <Header variant="h3">
                    {selectedItems.length} requests selected
                  </Header>
                </Box>
                <Box color="text-body-secondary" fontSize="body-s">
                  Multiple requests are selected. Delete them from their
                  collection below. Copies already saved in History or Favorites
                  are not affected.
                </Box>
                <Button variant="primary" onClick={handleDeleteRequests} loading={loading}>
                  Delete Request
                </Button>
              </SpaceBetween>
            ) : selectedCollection && requestDetails ? (
              <SpaceBetween size="m">
                <Box>
                  <Header variant="h3">
                    Request: {requestDetails.method}
                  </Header>
                </Box>

                <Box>
                  <SpaceBetween size="s">
                    <SpaceBetween direction="horizontal" size="s">
                      <Button variant="primary" onClick={handlePinToDashboard} loading={loading}>
                        &lt; Pin To Dashboard
                      </Button>
                      <Button onClick={handleDeleteRequests} loading={loading}>
                        Delete Request
                      </Button>
                    </SpaceBetween>
                    <Box color="text-body-secondary" fontSize="body-s">
                      Imported requests aren't tied to a profile. Choose a profile
                      and authentication mode below, then pin.
                    </Box>
                    <FormField label="Profile">
                      <Select
                        selectedOption={selectedPinProfile}
                        onChange={({ detail }) => {
                          setSelectedPinProfile(detail.selectedOption);
                          setSelectedPinAuthnMode(null);
                        }}
                        options={profileOptions}
                        filteringType="auto"
                        placeholder={profileOptions.length ? "Choose a profile" : "No profiles available"}
                        empty="No profiles found. Create one on the Profiles page."
                      />
                    </FormField>
                    {selectedPinProfile && pinAuthnModeOptions.length > 0 && (
                      <FormField label="Authentication mode">
                        <Select
                          selectedOption={selectedPinAuthnMode || pinAuthnModeOptions[0]}
                          onChange={({ detail }) => setSelectedPinAuthnMode(detail.selectedOption)}
                          options={pinAuthnModeOptions}
                        />
                      </FormField>
                    )}
                    {selectedPinProfile && pinAuthnModeOptions.length === 0 && (
                      <Alert type="warning">
                        This profile has no configured authentication mechanism. Pick another profile.
                      </Alert>
                    )}
                  </SpaceBetween>
                </Box>

                <ExpandableSection headerText="Request Details" defaultExpanded>
                  <Box padding="s">
                    <SpaceBetween size="m">
                      <FormField label="Collection">
                        <Input value={requestDetails.collectionName || selectedCollection.collectionName || "—"} readOnly />
                      </FormField>
                      <FormField label="Request Name">
                        <Input value={requestDetails.requestName || selectedCollection.requestName || ""} readOnly />
                      </FormField>
                      <FormField label="Endpoint">
                        <Input value={requestDetails.endpoint || selectedCollection.endpoint || ""} readOnly />
                      </FormField>
                      <FormField label="Method">
                        <Input value={requestDetails.method || selectedCollection.method || ""} readOnly />
                      </FormField>
                      <FormField label="Request Auth Type">
                        <Input value={requestDetails.requestAuthType || selectedCollection.requestAuthType || ""} readOnly />
                      </FormField>
                      <FormField label="Header">
                        <Textarea 
                          value={typeof requestDetails.header === 'string' 
                            ? requestDetails.header 
                            : JSON.stringify(requestDetails.header || selectedCollection.header || {}, null, 2)} 
                          readOnly 
                          rows={5}
                          style={{ fontFamily: "monospace", fontSize: "12px" }}
                        />
                      </FormField>
                      <FormField label="Body">
                        <Textarea 
                          value={typeof requestDetails.body === 'string' 
                            ? requestDetails.body 
                            : JSON.stringify(requestDetails.body || selectedCollection.body || {}, null, 2)} 
                          readOnly 
                          rows={8}
                          style={{ fontFamily: "monospace", fontSize: "12px" }}
                        />
                      </FormField>
                      <FormField label="Request Label">
                        <Input value={requestDetails.requestLabel || selectedCollection.requestLabel || "Not Specified"} readOnly />
                      </FormField>
                      {selectedCollection.request && (
                        <Box>
                          <strong>Full Request Object:</strong>
                          <pre style={{ 
                            background: "#f3f4f6", 
                            padding: "12px", 
                            borderRadius: "4px", 
                            overflow: "auto",
                            fontSize: "12px",
                            fontFamily: "monospace",
                            maxHeight: "300px",
                            margin: "8px 0"
                          }}>
                            {JSON.stringify(selectedCollection.request, null, 2)}
                          </pre>
                        </Box>
                      )}
                    </SpaceBetween>
                  </Box>
                </ExpandableSection>
              </SpaceBetween>
            ) : (
              <Box textAlign="center" color="text-body-secondary" padding="xxl">
                Select a collection to view details
              </Box>
            )}
        </div>
      </div>
      {confirmDialog}
    </div>
  );
}

export default PresignTemplates;

