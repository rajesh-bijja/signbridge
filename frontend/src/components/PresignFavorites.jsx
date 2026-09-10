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
  Textarea,
  ExpandableSection
} from "@cloudscape-design/components";
import * as presignApi from "./presignApi";
import { useConfirm } from "./ConfirmDialog";
import { getSocket, getUserName } from "./presignSocket";
import { appPath } from "../appConfig";

function PresignFavorites() {
  const { confirm, confirmDialog } = useConfirm();
  const [favorites, setFavorites] = useState([]);
  const [selectedFavorite, setSelectedFavorite] = useState(null);
  // Multi-select: the checked rows. Details are only shown when exactly one is
  // selected; with more than one, only the bulk delete action is offered.
  const [selectedItems, setSelectedItems] = useState([]);
  const [searchLabel, setSearchLabel] = useState("");
  const [requestLabel, setRequestLabel] = useState("");
  const [responseData, setResponseData] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  // Whether to show the delete confirmation dialog. Controlled by the
  // "Prompt Request Deletion in Favorites" setting; defaults to true when unset.
  const [promptOnDelete, setPromptOnDelete] = useState(true);
  const [leftWidth, setLeftWidth] = useState(50); // percent width of the left panel
  const socketRef = useRef(null);
  const selectedFavoriteIdRef = useRef(null);
  const splitContainerRef = useRef(null);
  const isDraggingSplitterRef = useRef(false);

  useEffect(() => {
    loadFavorites();
    loadDeletePrompt();

    // Initialize socket connection
    const socket = getSocket();
    socketRef.current = socket;
    const userName = getUserName();
    const displayFavoriteProgressEvent = 'event_display_favorite_details_' + userName;
    
    // Listen for favorite details
    socket.on(displayFavoriteProgressEvent, (obj) => {
      if (selectedFavoriteIdRef.current === obj.favoriteId) {
        const requestExecutionStatus = obj.status;
        let statHtml = '';
        if (requestExecutionStatus === 'Complete') {
          statHtml = 'Complete';
        } else if (requestExecutionStatus === 'Failed') {
          statHtml = 'Failed';
        } else {
          statHtml = 'Unknown';
        }
        
        const overallTextJsonObj = obj.data;
        if (overallTextJsonObj && overallTextJsonObj.request && overallTextJsonObj.response) {
          // Update selected favorite with full details
          setSelectedFavorite(prev => ({
            ...prev,
            request: overallTextJsonObj.request,
            response: overallTextJsonObj.response,
            responseHeaders: overallTextJsonObj.response.responseHeaders || {},
            status: statHtml,
            requestStatus: statHtml
          }));
          setResponseData(JSON.stringify(overallTextJsonObj, null, 2));
        } else {
          setError("Failed to load request/response details");
        }
        setLoading(false);
      }
    });
    
    return () => {
      // Cleanup: remove socket listener on unmount
      socket.off(displayFavoriteProgressEvent);
    };
  }, []);

  const loadDeletePrompt = async () => {
    try {
      const settings = await presignApi.populateSettingsDetails();
      // Default to prompting (true) when the setting is absent.
      setPromptOnDelete(settings?.shouldPromptFavoriteDeletion ?? true);
    } catch {
      // On failure, keep the safe default (prompt before deleting).
    }
  };

  // Draggable splitter between the list (left) and details (right).
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

  const loadFavorites = async (label = null) => {
    try {
      const data = await presignApi.populateFavoriteDetails(label);
      if (data && data.length > 0) {
        const formattedData = data.map((item, index) => ({
          id: index + 1,
          favoriteId: item.executionDetailsFileName?.replace(".json", "") || "",
          method: item.method || "",
          profileName: item.profileName || "",
          status: item.requestStatus || "",
          executedOn: item.executedDateReadable?.replace(" (Coordinated Universal Time)", "") || "",
          authnMode: item.authnMode || "",
          requestLabel: item.requestLabel || "Not Specified",
          ...item
        }));
        setFavorites(formattedData);
      } else {
        setFavorites([]);
      }
    } catch (err) {
      setError("Failed to load favorites: " + err.message);
    }
  };

  const handleSearch = () => {
    loadFavorites(searchLabel || null);
    setSelectedFavorite(null);
    setSelectedItems([]);
    setResponseData("");
    setRequestLabel("");
  };

  // Load and show the details for a single favorite in the right panel.
  const showFavoriteDetails = (item) => {
    setSelectedFavorite(item);
    setRequestLabel(item.requestLabel || "");
    selectedFavoriteIdRef.current = item.favoriteId;
    setLoading(true);
    setError(null);
    setResponseData("Loading favorite details...");

    // Emit socket event to fetch details (following SignBridge pattern)
    const socket = socketRef.current;
    if (socket) {
      const userName = getUserName();
      const eventObj = {
        favoriteId: item.favoriteId,
        userName: userName,
        requestStatus: item.status || item.requestStatus || 'Complete'
      };
      socket.emit('event_get_favorite_id_log', eventObj);
    } else {
      setError("Socket connection not available");
      setLoading(false);
    }
  };

  // Clicking a row selects just that row (and shows its details).
  const handleRowClick = (item) => {
    setSelectedItems([item]);
    showFavoriteDetails(item);
  };

  // Checkbox selection: show details only for a single selection; for multiple,
  // clear the detail panel and offer the bulk delete action instead.
  const handleSelectionChange = (items) => {
    setSelectedItems(items);
    if (items.length === 1) {
      showFavoriteDetails(items[0]);
    } else {
      setSelectedFavorite(null);
      selectedFavoriteIdRef.current = null;
      setResponseData("");
      setRequestLabel("");
    }
  };

  const handleReRun = async () => {
    if (!selectedFavorite) {
      setError("Please select a favorite to re-run");
      return;
    }
    setSuccess("Request re-run initiated. Check the response panel.");
  };

  const handlePinToDashboard = async () => {
    if (!selectedFavorite) {
      setError("Please select a favorite to pin");
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      // Get the full request details from selectedFavorite
      const requestData = selectedFavorite.request;
      if (!requestData) {
        setError("Request details not available. Please wait for details to load.");
        setLoading(false);
        return;
      }

      // Check if profile exists first (following SignBridge pattern)
      const profileName = requestData.profileName;
      const authnMode = requestData.authnMode;
      
      if (!profileName || !authnMode) {
        setError("Profile name or authentication mode not available");
        setLoading(false);
        return;
      }

      try {
        await presignApi.checkProfileExists(profileName, authnMode);
      } catch (err) {
        setError("Profile does not exist: " + err.message);
        setLoading(false);
        return;
      }

      // Extract endpoint and query parameters
      let endpointBase = requestData.endpoint || "";
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

      // Process headers - copy all headers first (needed for content type determination)
      const processedHeaders = {};
      if (requestData.headers && typeof requestData.headers === 'object') {
        Object.keys(requestData.headers).forEach(key => {
          processedHeaders[key] = requestData.headers[key];
        });
      }

      // Determine content type from headers
      let contentType = "application/json";
      let customContentType = "";
      const headerContentType = processedHeaders['Content-Type'] || processedHeaders['content-type'];
      if (headerContentType) {
        const defaultContentTypes = ["application/json", "text/html", "application/x-www-form-urlencoded; charset=utf-8"];
        if (defaultContentTypes.includes(headerContentType)) {
          contentType = headerContentType;
        } else {
          contentType = "custom";
          customContentType = headerContentType;
        }
      }

      // Process payload - handle both string and object formats (following SignBridge pattern)
      let processedPayload = "";
      if (requestData.body !== undefined && requestData.body !== null) {
        if (typeof requestData.body === 'string') {
          processedPayload = requestData.body;
          // For form-urlencoded, remove quotes if present (following SignBridge pattern)
          if (contentType.toLowerCase().includes('form-urlencoded')) {
            if (processedPayload.startsWith('"')) {
              processedPayload = processedPayload.substring(1);
            }
            if (processedPayload.endsWith('"')) {
              processedPayload = processedPayload.substring(0, processedPayload.length - 1);
            }
          }
        } else if (typeof requestData.body === 'object') {
          // For JSON content type, stringify; for form-urlencoded, handle specially
          if (contentType.toLowerCase().includes('application/json')) {
            processedPayload = JSON.stringify(requestData.body);
          } else if (contentType.toLowerCase().includes('form-urlencoded')) {
            // For form-urlencoded, convert object to string format
            processedPayload = JSON.stringify(requestData.body);
          } else if (contentType.toLowerCase() === 'text/html') {
            // For text/html, keep as string
            processedPayload = String(requestData.body);
          } else {
            // For other types, stringify
            processedPayload = JSON.stringify(requestData.body);
          }
        } else {
          processedPayload = String(requestData.body);
        }
      }

      // Prepare pinned data with all request details
      const pinnedData = {
        profileName: profileName,
        authnMechanism: authnMode,
        invocationMode: requestData.invocationMode || "Rest_Api",
        httpMethod: requestData.method || "GET",
        endpoint: endpointBase, // Base endpoint without query params
        payload: processedPayload,
        commandPayload: requestData.commandPayload || "",
        headers: processedHeaders,
        contentType: contentType,
        customContentType: customContentType,
        queryParams: queryParams,
        isUrlPresigningRequest: requestData.isUrlPresigningRequest || false
      };

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

  const handleDelete = async () => {
    if (selectedItems.length === 0) {
      setError("Please select one or more favorites to delete");
      return;
    }

    if (promptOnDelete) {
      const count = selectedItems.length;
      const confirmed = await confirm({
        title: "Delete favorites",
        message:
          count === 1
            ? "Are you sure you want to delete this favorite?"
            : `Are you sure you want to delete these ${count} favorites?`
      });
      if (!confirmed) {
        return;
      }
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      // Delete each selected favorite; collect failures so partial success is
      // reported rather than swallowed.
      const failures = [];
      for (const item of selectedItems) {
        try {
          await presignApi.deleteFavoriteDetails(item.favoriteId);
        } catch (err) {
          failures.push(item.favoriteId?.substring(0, 8) || item.favoriteId);
        }
      }
      const deleted = selectedItems.length - failures.length;
      if (failures.length === 0) {
        setSuccess(`Deleted ${deleted} ${deleted === 1 ? "favorite" : "favorites"} successfully`);
      } else {
        setError(`Deleted ${deleted}, failed to delete ${failures.length} (${failures.join(", ")})`);
      }
      setSelectedFavorite(null);
      setSelectedItems([]);
      setResponseData("");
      loadFavorites(searchLabel || null);
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to delete favorite");
    } finally {
      setLoading(false);
    }
  };

  const handleApplyLabel = async () => {
    if (!selectedFavorite || !requestLabel) {
      setError("Please select a favorite and enter a label");
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      await presignApi.applyLabelForFavorite(selectedFavorite.favoriteId, requestLabel);
      setSuccess("Label applied successfully");
      loadFavorites(searchLabel || null);
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to apply label");
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    setSuccess("Copied to clipboard");
    setTimeout(() => setSuccess(null), 3000);
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <Container
        header={
          <Header variant="h1" description="View and manage favorite API invocations">
            SignBridge Favorites
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

          <SpaceBetween direction="horizontal" size="s">
            <FormField label="Search by Label">
              <Input
                value={searchLabel}
                onChange={({ detail }) => setSearchLabel(detail.value)}
                placeholder="Enter label to search"
              />
            </FormField>
            <Button onClick={handleSearch}>Search</Button>
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
          <div style={{
            flex: "1",
            overflowY: "auto",
            overflowX: "auto",
            minHeight: 0
          }}>
            <Table
                columnDefinitions={[
                  { id: "id", header: "#", cell: (item) => item.id, width: "50px" },
                  { id: "favoriteId", header: "Id", cell: (item) => item.favoriteId?.substring(0, 8) || "", width: "100px" },
                  { id: "method", header: "Invocation", cell: (item) => item.method, width: "100px" },
                  { id: "profileName", header: "Profile Name", cell: (item) => item.profileName },
                  {
                    id: "status",
                    header: "Status",
                    cell: (item) => (
                      <span style={{ color: item.status === "Complete" ? "green" : "red" }}>
                        {item.status === "Complete" ? "✓" : "✗"} {item.status}
                      </span>
                    ),
                    width: "120px"
                  },
                  { id: "executedOn", header: "Executed On", cell: (item) => item.executedOn, width: "200px" },
                  { id: "authnMode", header: "Authn Mode", cell: (item) => item.authnMode, width: "120px" },
                  { id: "requestLabel", header: "Request Label", cell: (item) => item.requestLabel }
                ]}
                items={favorites}
                trackBy="favoriteId"
                onRowClick={({ detail }) => handleRowClick(detail.item)}
                onSelectionChange={({ detail }) => handleSelectionChange(detail.selectedItems)}
                selectedItems={selectedItems}
                selectionType="multi"
                stickyHeader
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
                  <Header variant="h3">{selectedItems.length} favorites selected</Header>
                  <Box color="text-body-secondary">
                    Multiple favorites are selected. Choose a bulk action below.
                    Favorite details are shown only when a single favorite is selected.
                  </Box>
                </Box>
                <SpaceBetween direction="horizontal" size="s" wrap="wrap">
                  <Button variant="normal" onClick={handleDelete} loading={loading}>
                    ! Delete Favorite
                  </Button>
                </SpaceBetween>
              </SpaceBetween>
            ) : selectedFavorite ? (
              <SpaceBetween size="m">
                <Box>
                  <Header variant="h3">
                    Request: {selectedFavorite.method} Status:{" "}
                    <span style={{ color: selectedFavorite.status === "Complete" ? "green" : "red" }}>
                      {selectedFavorite.status}
                    </span>
                  </Header>
                </Box>

                <SpaceBetween direction="horizontal" size="s" wrap="wrap">
                  <Button onClick={() => copyToClipboard(responseData)}>Copy All</Button>
                  <Button onClick={() => copyToClipboard(JSON.stringify(selectedFavorite.response || {}, null, 2))}>
                    Copy Response Data
                  </Button>
                  <Button onClick={() => copyToClipboard(JSON.stringify(selectedFavorite.responseHeaders || {}, null, 2))}>
                    Copy Response Headers
                  </Button>
                  <Button onClick={() => {
                    let endpoint = "";
                    if (selectedFavorite.request) {
                      if (typeof selectedFavorite.request === 'object' && selectedFavorite.request.endpoint) {
                        endpoint = selectedFavorite.request.endpoint;
                      } else if (typeof selectedFavorite.request === 'string') {
                        try {
                          const requestObj = JSON.parse(selectedFavorite.request);
                          endpoint = requestObj.endpoint || "";
                        } catch (e) {
                          endpoint = "";
                        }
                      }
                    }
                    if (!endpoint && selectedFavorite.endpoint) {
                      endpoint = selectedFavorite.endpoint;
                    }
                    copyToClipboard(endpoint);
                  }}>Copy Endpoint</Button>
                </SpaceBetween>

                <SpaceBetween direction="horizontal" size="s" wrap="wrap">
                  <Button variant="primary" onClick={handlePinToDashboard}>
                    &lt; Pin To Dashboard
                  </Button>
                  <Button variant="normal" onClick={handleDelete} loading={loading}>
                    ! Delete Favorite
                  </Button>
                  <Button variant="primary" onClick={handleReRun} loading={loading}>
                    ► Re-Run
                  </Button>
                </SpaceBetween>

                <FormField label="Label Name">
                  <SpaceBetween direction="horizontal" size="s">
                    <Input
                      value={requestLabel}
                      onChange={({ detail }) => setRequestLabel(detail.value)}
                      placeholder="Not Specified"
                    />
                    <Button onClick={handleApplyLabel} loading={loading}>
                      ✓ Apply Label
                    </Button>
                  </SpaceBetween>
                </FormField>

                <ExpandableSection headerText="Request/Response Details" defaultExpanded>
                  <Box padding="s">
                    <SpaceBetween size="m">
                      <Box>
                        <strong>Request:</strong>
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
                          {JSON.stringify(selectedFavorite.request || {}, null, 2)}
                        </pre>
                      </Box>
                      <Box>
                        <strong>Response:</strong>
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
                          {JSON.stringify(selectedFavorite.response || {}, null, 2)}
                        </pre>
                      </Box>
                      {selectedFavorite.responseHeaders && (
                        <Box>
                          <strong>Response Headers:</strong>
                          <pre style={{ 
                            background: "#f3f4f6", 
                            padding: "12px", 
                            borderRadius: "4px", 
                            overflow: "auto",
                            fontSize: "12px",
                            fontFamily: "monospace",
                            maxHeight: "200px",
                            margin: "8px 0"
                          }}>
                            {JSON.stringify(selectedFavorite.responseHeaders, null, 2)}
                          </pre>
                        </Box>
                      )}
                    </SpaceBetween>
                  </Box>
                </ExpandableSection>
              </SpaceBetween>
            ) : (
              <Box textAlign="center" color="text-body-secondary" padding="xxl">
                Select a favorite to view details
              </Box>
            )}
        </div>
      </div>
      {confirmDialog}
    </div>
  );
}

export default PresignFavorites;

