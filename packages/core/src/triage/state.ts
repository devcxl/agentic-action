export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

export function buildIssueState(
  input: { title?: string | null; body?: string | null },
  maxBodyChars = 8000,
): { title: string; body: string } {
  const title = String(input.title ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
  const cleanedBody = stripHtmlComments(String(input.body ?? ""))
    .replace(/\r\n/g, "\n")
    .trim();
  const limit = maxBodyChars > 0 ? maxBodyChars : 8000;
  const body =
    cleanedBody.length > limit ? cleanedBody.slice(0, limit) : cleanedBody;

  return { title, body };
}

export function buildPrState(
  input: {
    title?: string | null;
    body?: string | null;
    files: readonly string[];
  },
  maxBodyChars = 8000,
): { title: string; body: string; files: string[] } {
  const { title, body } = buildIssueState(
    { title: input.title, body: input.body },
    maxBodyChars,
  );
  const files = input.files.slice(0, 500).map((f) => String(f));
  return { title, body, files };
}
