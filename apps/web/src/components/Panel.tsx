import type { ReactNode } from "react";
import { errorCode } from "../services";
import type { AsyncState } from "../hooks";
import styles from "./Panel.module.css";

interface Props<T> {
  title: string;
  state: AsyncState<T> & { reload?: () => void };
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  actions?: ReactNode;
  children: (data: T) => ReactNode;
  testId?: string;
  headingLevel?: 2 | 3;
  showHeading?: boolean;
  bare?: boolean;
}

/** Every data panel renders loading / empty / error / permission states. */
export function Panel<T>({ title, state, isEmpty, empty, actions, children, testId, headingLevel = 2, showHeading = true, bare = false }: Props<T>) {
  const H = headingLevel === 2 ? "h2" : "h3";
  let body: ReactNode;
  if (state.status === "error") {
    const code = errorCode(state.error);
    const message = (state.error as Error)?.message ?? "Unknown error";
    body =
      code === "permission_denied" ? (
        <div className={styles.permission} role="alert" data-testid="permission-state">
          <strong>Access denied.</strong> {message}
        </div>
      ) : (
        <div className={styles.error} role="alert" data-testid="error-state">
          <strong>{code === "not_found" ? "Not found." : code === "invalid_data" ? "Data did not match contracts." : "Could not load."}</strong>{" "}
          {message}
          {state.reload && (
            <button type="button" onClick={state.reload}>
              Retry
            </button>
          )}
        </div>
      );
  } else if (state.status === "loading" && state.data === undefined) {
    body = (
      <div className={styles.loading} role="status" data-testid="loading-state">
        Loading {title.toLowerCase()}…
      </div>
    );
  } else {
    const data = state.data as T;
    body = isEmpty?.(data) ? <div className={styles.empty} data-testid="empty-state">{empty ?? "Nothing here yet."}</div> : children(data);
  }
  return (
    <section className={`${styles.panel} ${bare ? styles.bare : ""}`} aria-label={showHeading ? undefined : title} aria-labelledby={showHeading ? `${title}-h` : undefined} data-testid={testId} aria-busy={state.status === "loading"}>
      {showHeading && <header className={styles.head}>
        <H id={`${title}-h`}>{title}</H>
        {actions}
      </header>}
      {body}
    </section>
  );
}

export function Badge({ tone, children, title }: { tone: "blue" | "green" | "amber" | "red" | "gray"; children: ReactNode; title?: string }) {
  return (
    <span className={`${styles.badge} ${styles[tone]}`} title={title}>
      {children}
    </span>
  );
}
