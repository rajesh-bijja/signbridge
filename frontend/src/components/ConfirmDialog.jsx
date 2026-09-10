import React, { useCallback, useRef, useState } from "react";
import {
  Modal,
  Box,
  Button,
  SpaceBetween,
  FormField,
  Input,
  Spinner
} from "@cloudscape-design/components";

// A themed replacement for the native `window.confirm`. Instead of the browser's
// blocking pop-up, this renders a Cloudscape modal that matches the rest of the
// app. `useConfirm()` returns a promise-based `confirm()` function so existing
// `if (!window.confirm(...)) return;` guards convert to `if (!(await confirm(...))) return;`
// with no other change to the calling code.
//
// Usage:
//   const { confirm, confirmDialog } = useConfirm();
//   ...
//   if (!(await confirm({ message: "Delete this?" }))) return;
//   ...
//   return (<>{...page...}{confirmDialog}</>);
export function useConfirm() {
  const [state, setState] = useState(null); // { title, message, confirmLabel, cancelLabel, danger }
  const resolverRef = useRef(null);

  const confirm = useCallback((options = {}) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setState({
        title: options.title || "Confirm",
        message: options.message || "Are you sure?",
        confirmLabel: options.confirmLabel || "Delete",
        cancelLabel: options.cancelLabel || "Cancel",
        danger: options.danger !== false // default to destructive styling
      });
    });
  }, []);

  const settle = useCallback((result) => {
    if (resolverRef.current) {
      resolverRef.current(result);
      resolverRef.current = null;
    }
    setState(null);
  }, []);

  const confirmDialog = (
    <Modal
      visible={!!state}
      onDismiss={() => settle(false)}
      header={state?.title}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => settle(false)}>
              {state?.cancelLabel}
            </Button>
            <Button
              variant={state?.danger ? "primary" : "normal"}
              onClick={() => settle(true)}
            >
              {state?.confirmLabel}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      {state?.message}
    </Modal>
  );

  return { confirm, confirmDialog };
}

// A themed replacement for the native `window.prompt`. `prompt()` opens a modal
// with a single text input and resolves to the entered string, or `null` if the
// user cancels/dismisses. An optional async `onSubmit(value)` runs while a busy
// spinner shows; if it throws, the modal stays open so the user can retry.
//
// Usage:
//   const { prompt, promptDialog } = usePrompt();
//   ...
//   const title = await prompt({ title: "Rename", initialValue: thread.title,
//     onSubmit: (v) => renameChatThread(id, v) });
//   if (title == null) return; // cancelled
//   ...
//   return (<>{...page...}{promptDialog}</>);
export function usePrompt() {
  const [state, setState] = useState(null); // { title, label, placeholder, confirmLabel, cancelLabel, maxLength, onSubmit }
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const resolverRef = useRef(null);

  const prompt = useCallback((options = {}) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setValue(options.initialValue || "");
      setBusy(false);
      setState({
        title: options.title || "Enter a value",
        label: options.label || "",
        placeholder: options.placeholder || "",
        confirmLabel: options.confirmLabel || "Save",
        cancelLabel: options.cancelLabel || "Cancel",
        maxLength: options.maxLength || 120,
        onSubmit: options.onSubmit || null
      });
    });
  }, []);

  const finish = useCallback((result) => {
    if (resolverRef.current) {
      resolverRef.current(result);
      resolverRef.current = null;
    }
    setState(null);
    setBusy(false);
  }, []);

  const cancel = useCallback(() => {
    if (busy) return;
    finish(null);
  }, [busy, finish]);

  const submit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (state?.onSubmit) {
      setBusy(true);
      try {
        await state.onSubmit(trimmed);
      } catch {
        // keep the modal open so the user can retry
        setBusy(false);
        return;
      }
    }
    finish(trimmed);
  }, [value, state, finish]);

  const promptDialog = (
    <Modal
      visible={!!state}
      onDismiss={cancel}
      header={state?.title}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={cancel} disabled={busy}>
              {state?.cancelLabel}
            </Button>
            <Button variant="primary" onClick={submit} disabled={busy || !value.trim()}>
              {busy ? <Spinner /> : state?.confirmLabel}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <FormField label={state?.label || undefined}>
        <Input
          autoFocus
          value={value}
          placeholder={state?.placeholder}
          onChange={({ detail }) => setValue(detail.value.slice(0, state?.maxLength || 120))}
          onKeyDown={({ detail }) => {
            if (detail.key === "Enter") submit();
          }}
        />
      </FormField>
    </Modal>
  );

  return { prompt, promptDialog };
}

export default useConfirm;
