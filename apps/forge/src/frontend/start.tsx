import React, { useState } from "react";
import { invoke, view } from "@forge/bridge";
import ForgeReconciler, {
  Button,
  Form,
  FormFooter,
  Heading,
  Label,
  SectionMessage,
  Stack,
  Text,
  Textfield,
} from "@forge/react";
import type { StartInvestigationResponse } from "@forksafe/integrations-atlassian";

type ResolverResult =
  | { ok: true; mode: string; data: StartInvestigationResponse }
  | { ok: false; code: string; message: string };

function StartForm() {
  const [result, setResult] = useState<ResolverResult>();
  const [submitting, setSubmitting] = useState(false);
  const [title, setTitle] = useState("");
  const [requestedEnvironments, setRequestedEnvironments] = useState("3");
  const [confluencePageId, setConfluencePageId] = useState("");

  async function onSubmit() {
    setSubmitting(true);
    setResult(undefined);
    try {
      const response = await invoke<ResolverResult>("startInvestigation", {
        title,
        requestedEnvironments,
        confluencePageId,
      });
      setResult(invokeResult(response));
    } catch {
      setResult({
        ok: false,
        code: "backend_error",
        message: "The investigation could not be started.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Stack space="space.200">
      <Heading as="h2">Start a ForkSafe investigation</Heading>
      <Text>Choose a short title and how many environments to compare.</Text>
      <Form onSubmit={onSubmit}>
        <Label labelFor="investigation-title">Investigation title</Label>
        <Textfield
          id="investigation-title"
          name="title"
          placeholder="Issue key + investigation"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Label labelFor="requested-environments">Environments (1–10)</Label>
        <Textfield
          id="requested-environments"
          name="requestedEnvironments"
          type="number"
          value={requestedEnvironments}
          onChange={(event) => setRequestedEnvironments(event.target.value)}
          isRequired
        />
        <Label labelFor="confluence-page-id">
          Confluence requirements page ID (optional)
        </Label>
        <Textfield
          id="confluence-page-id"
          name="confluencePageId"
          placeholder="123456789"
          value={confluencePageId}
          onChange={(event) => setConfluencePageId(event.target.value)}
        />
        <FormFooter>
          <Button
            type="submit"
            appearance="primary"
            isDisabled={submitting}
          >
            {submitting ? "Starting…" : "Start investigation"}
          </Button>
        </FormFooter>
      </Form>
      {result && (
        <SectionMessage
          appearance={result.ok ? "success" : "error"}
          title={result.ok ? "Investigation started" : result.code}
        >
          <Text>
            {result.ok
              ? `Investigation ${result.data.investigationId} is ${result.data.state} (${result.mode}).`
              : result.message}
          </Text>
          <Button onClick={() => void view.close()}>Close</Button>
        </SectionMessage>
      )}
    </Stack>
  );
}

function invokeResult<T>(response: T | { body: T }): T {
  return response !== null &&
    typeof response === "object" &&
    "body" in response
    ? response.body as T
    : response as T;
}

ForgeReconciler.render(<StartForm />);
