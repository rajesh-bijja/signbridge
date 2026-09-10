import React, { useState, useEffect } from "react";
import {
  Container,
  Header,
  Input,
  Button,
  SpaceBetween,
  FormField,
  Box,
  Alert,
  Checkbox,
  Table,
  ExpandableSection
} from "@cloudscape-design/components";
import * as presignApi from "./presignApi";
import LlmSettingsPanel from "./llm/LlmSettingsPanel.jsx";

function PresignSettings() {
  const [tinyUrlEnabled, setTinyUrlEnabled] = useState(false);
  const [tinyUrlToken, setTinyUrlToken] = useState("");
  const [promptHistoryDeletion, setPromptHistoryDeletion] = useState(false);
  const [promptFavoriteDeletion, setPromptFavoriteDeletion] = useState(false);
  const [promptCollectionRequestDeletion, setPromptCollectionRequestDeletion] = useState(false);
  const [promptCollectionDeletion, setPromptCollectionDeletion] = useState(false);
  const [variables, setVariables] = useState([]);
  const [variableName, setVariableName] = useState("");
  const [variableValue, setVariableValue] = useState("");
  const [selectedVariable, setSelectedVariable] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const data = await presignApi.populateSettingsDetails();
      if (data) {
        setTinyUrlEnabled(data.tinyUrlIntegration?.isEnabled || false);
        setTinyUrlToken(data.tinyUrlIntegration?.token || "");
        // Default to prompting (true) when the setting is absent — a missing
        // value should not silently disable the confirmation dialog.
        setPromptHistoryDeletion(data.shouldPromptHistoryDeletion ?? true);
        setPromptFavoriteDeletion(data.shouldPromptFavoriteDeletion ?? true);
        setPromptCollectionRequestDeletion(data.shouldPromptCollectionRequestDeletion ?? true);
        setPromptCollectionDeletion(data.shouldPromptCollectionDeletion ?? true);
        setVariables(data.variables || []);
      }
    } catch (err) {
      setError("Failed to load settings: " + err.message);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const settings = {
        tinyUrlIntegration: {
          isEnabled: tinyUrlEnabled,
          token: tinyUrlToken
        },
        shouldPromptHistoryDeletion: promptHistoryDeletion,
        shouldPromptFavoriteDeletion: promptFavoriteDeletion,
        shouldPromptCollectionRequestDeletion: promptCollectionRequestDeletion,
        shouldPromptCollectionDeletion: promptCollectionDeletion,
        variables: variables
      };

      await presignApi.updateSettingsDetails(settings);
      setSuccess("Settings updated successfully");
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to update settings");
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    loadSettings();
    setError(null);
    setSuccess(null);
  };

  const handleAddVariable = () => {
    if (!variableName || !variableValue) {
      setError("Variable name and value are required");
      return;
    }

    const newVariables = [...variables, { name: variableName, value: variableValue }];
    setVariables(newVariables);
    setVariableName("");
    setVariableValue("");
    setSelectedVariable(null);
  };

  const handleRemoveVariable = () => {
    if (!selectedVariable) {
      setError("Please select a variable to remove");
      return;
    }

    const newVariables = variables.filter((v) => v.name !== selectedVariable.name);
    setVariables(newVariables);
    setSelectedVariable(null);
    setVariableName("");
    setVariableValue("");
  };

  const handleVariableRowClick = (item) => {
    setSelectedVariable(item);
    setVariableName(item.name);
    setVariableValue(item.value);
  };

  return (
    <SpaceBetween size="l">
    <Container
      header={
        <Header variant="h1" description="Configure SignBridge application settings">
          SignBridge Settings
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

        <ExpandableSection headerText="Variables" defaultExpanded={false}>
          <SpaceBetween size="m">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
              <Box>
                <Table
                  columnDefinitions={[
                    { id: "name", header: "Name", cell: (item) => item.name },
                    { id: "value", header: "Value", cell: (item) => item.value }
                  ]}
                  items={variables}
                  onRowClick={({ detail }) => handleVariableRowClick(detail.item)}
                  selectedItems={selectedVariable ? [selectedVariable] : []}
                  selectionType="single"
                />
              </Box>

              <Box>
                <SpaceBetween size="s">
                  <FormField label="Variable Name">
                    <Input
                      value={variableName}
                      onChange={({ detail }) => setVariableName(detail.value)}
                      placeholder="Enter variable name"
                    />
                  </FormField>
                  <FormField label="Variable Value">
                    <Input
                      value={variableValue}
                      onChange={({ detail }) => setVariableValue(detail.value)}
                      placeholder="Enter variable value"
                    />
                  </FormField>
                  <SpaceBetween direction="horizontal" size="s">
                    <Button onClick={handleAddVariable}>Add</Button>
                    <Button onClick={handleRemoveVariable} disabled={!selectedVariable}>
                      Remove
                    </Button>
                  </SpaceBetween>
                </SpaceBetween>
              </Box>
            </div>
          </SpaceBetween>
        </ExpandableSection>

        <Checkbox
          checked={tinyUrlEnabled}
          onChange={({ detail }) => setTinyUrlEnabled(detail.checked)}
        >
          Enable Tiny Url Integration
        </Checkbox>

        {tinyUrlEnabled && (
          <FormField label="Token *" description="Tiny URL API token">
            <Input
              value={tinyUrlToken}
              onChange={({ detail }) => setTinyUrlToken(detail.value)}
              type="password"
              placeholder="Enter Tiny URL token"
            />
          </FormField>
        )}

        <Checkbox
          checked={promptHistoryDeletion}
          onChange={({ detail }) => setPromptHistoryDeletion(detail.checked)}
        >
          Prompt Request Deletion in History
        </Checkbox>

        <Checkbox
          checked={promptFavoriteDeletion}
          onChange={({ detail }) => setPromptFavoriteDeletion(detail.checked)}
        >
          Prompt Request Deletion in Favorites
        </Checkbox>

        <Checkbox
          checked={promptCollectionRequestDeletion}
          onChange={({ detail }) => setPromptCollectionRequestDeletion(detail.checked)}
        >
          Prompt Request Deletion in a Collection
        </Checkbox>

        <Checkbox
          checked={promptCollectionDeletion}
          onChange={({ detail }) => setPromptCollectionDeletion(detail.checked)}
        >
          Prompt Collection Deletion
        </Checkbox>

        <SpaceBetween direction="horizontal" size="s">
          <Button onClick={handleSave} loading={loading} variant="primary">
            Save
          </Button>
          <Button onClick={handleReset} disabled={loading}>
            Reset
          </Button>
        </SpaceBetween>
      </SpaceBetween>
    </Container>

    {/* Its own container, and its own save behaviour: every action in there is a
        round trip to an AI provider whose result has to be stored to be useful, so
        it does not share the Save button above. */}
    <LlmSettingsPanel />
    </SpaceBetween>
  );
}

export default PresignSettings;

