// Review pane of the document edit mode (right dock, '검토'): the markup / final view switch, recording changes on /
// off, the document's comments (author, time, text, the words they are on, replies, resolved) and its tracked changes
// in reading order — as Word's '검토 창' and 한글's '메모·변경 내용' show them. A click goes to the place in the body;
// from stage 2 comments are added, answered, resolved, edited and deleted here, and changes accepted or rejected one
// by one or all at once (ui/reviewActions.ts).

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../core/store";
import { authorColor, collectChanges, commentThreads, commentedText, docComments, MOVE_COLOR, pageParagraphs, type ChangeItem } from "../../core/review";
import type { DocComment } from "../../core/types";
import { closeComposer, deleteComment, editStart, goToParagraph, reply, resolveDoc, selectComment, setCommentDone, setReviewViewNow, setTrackingNow, startComment, submitComposer, useReview } from "../reviewActions";
import { Section, Seg, cx } from "./controls";
import { useLang, useT } from "../../i18n";
import "./review.css";

/**
 * A file's time in the viewer's language, the clock time as the file writes it: Word's w:date and 한글's memo time are
 * the writer's local time (with a "Z" that does not mean UTC; Word keeps the UTC time apart), so it is not converted.
 */
function when(date: string | undefined, lang: string): string {
  const m = date && /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(date);
  if (!m) return date ?? "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  return d.toLocaleString(lang === "zh" ? "zh-Hans" : lang, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** The box a comment is written in (new, reply, edit): Ctrl+Enter sends, Esc closes. */
function ComposerBox({ initial = "", quote, label }: { initial?: string; quote?: string; label: string }) {
  const t = useT();
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <div className="rv-compose">
      {quote && <div className="rv-quote">{quote}</div>}
      <textarea
        ref={ref}
        className="rv-compose-text"
        aria-label={label}
        placeholder={label}
        value={text}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") closeComposer();
          else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submitComposer(text);
          }
        }}
      />
      <div className="rv-compose-actions">
        <button type="button" className="btn btn-sm" onClick={closeComposer}>
          {t("review.cancel")}
        </button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!text.trim()} onClick={() => submitComposer(text)} title="Ctrl+Enter">
          {t("review.post")}
        </button>
      </div>
    </div>
  );
}

function CommentCard({ c, replies, quote }: { c: DocComment; replies: DocComment[]; quote: string }) {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const active = useReview((s) => s.active === c.id);
  const composer = useReview((s) => s.composer);
  const editing = (x: DocComment) => composer?.mode === "edit" && composer.id === x.id;
  const head = (x: DocComment) => (
    <div className="rv-head">
      <span className="rv-dot" style={{ background: authorColor(x.author) }} aria-hidden />
      <span className="rv-author">{x.author || t("review.noAuthor")}</span>
      <span className="rv-date">{when(x.date, lang)}</span>
    </div>
  );
  const open = () => {
    selectComment(active ? null : c.id);
    goToParagraph(null, (runs) => runs.some((r) => r.comments?.includes(c.id)));
  };
  const tools = (x: DocComment, top: boolean) => (
    <div className="rv-tools">
      {top && (
        <button type="button" className="rv-tool" onClick={() => reply(c.id)}>
          {t("review.reply")}
        </button>
      )}
      {top && (
        <button type="button" className="rv-tool" onClick={() => setCommentDone(c.id, !c.done)}>
          {t(c.done ? "review.reopen" : "review.resolve")}
        </button>
      )}
      <button type="button" className="rv-tool" onClick={() => editStart(x)}>
        {t("review.edit")}
      </button>
      <button type="button" className="rv-tool danger" onClick={() => deleteComment(x.id)} title={top && replies.length ? t("review.deleteThreadTip") : undefined}>
        {t("review.delete")}
      </button>
    </div>
  );
  return (
    <li className={cx("rv-card", active && "on", c.done && "done")}>
      <button type="button" className="rv-card-btn" onClick={open} title={t("review.goTo")}>
        {head(c)}
        {quote && <div className="rv-quote">{quote}</div>}
        {!editing(c) && <div className="rv-text">{c.text}</div>}
        {c.done && <span className="rv-badge">{t("review.resolved")}</span>}
      </button>
      {editing(c) ? <ComposerBox initial={c.text} label={t("review.editLabel")} /> : tools(c, true)}
      {replies.length > 0 && (
        <ul className="rv-replies" aria-label={t("review.replies", { n: replies.length })}>
          {replies.map((r) => (
            <li key={r.id} className={cx("rv-reply", r.done && "done")}>
              {head(r)}
              {editing(r) ? <ComposerBox initial={r.text} label={t("review.editLabel")} /> : <div className="rv-text">{r.text}</div>}
              {!editing(r) && tools(r, false)}
            </li>
          ))}
        </ul>
      )}
      {composer?.mode === "reply" && composer.id === c.id && <ComposerBox label={t("review.replyLabel")} />}
    </li>
  );
}

function ChangeRow({ ch }: { ch: ChangeItem }) {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const color = ch.kind === "moveFrom" || ch.kind === "moveTo" ? MOVE_COLOR : authorColor(ch.author);
  return (
    <li className="rv-change">
      <button type="button" className="rv-card-btn" onClick={() => goToParagraph(ch.para)} title={t("review.goTo")}>
        <div className="rv-head">
          <span className="rv-dot" style={{ background: color }} aria-hidden />
          <span className="rv-kind">{t(`review.kind.${ch.kind}`)}</span>
          <span className="rv-date">{when(ch.date, lang)}</span>
        </div>
        {ch.text && <div className={cx("rv-ctext", `k-${ch.kind}`)} style={{ color }}>{ch.text}</div>}
        <div className="rv-by">{ch.author || t("review.noAuthor")}</div>
      </button>
      <div className="rv-tools">
        <button type="button" className="rv-tool" onClick={() => resolveDoc(true, ch)}>
          {t("review.accept")}
        </button>
        <button type="button" className="rv-tool" onClick={() => resolveDoc(false, ch)}>
          {t("review.reject")}
        </button>
      </div>
    </li>
  );
}

export function ReviewTab() {
  const t = useT();
  const pages = useStore((s) => s.doc.pages);
  const view = useReview((s) => s.view);
  const tracking = useReview((s) => s.tracking);
  const composer = useReview((s) => s.composer);
  const paras = useMemo(() => pageParagraphs(pages), [pages]);
  const comments = docComments(pages);
  const threads = useMemo(() => commentThreads(comments), [comments]);
  const changes = useMemo(() => collectChanges(paras), [paras]);
  return (
    <div className="dock-scroll review-pane">
      <Section title={t("review.view")}>
        <Seg
          value={view}
          ariaLabel={t("review.view")}
          onChange={setReviewViewNow}
          options={[
            { value: "markup", label: t("review.view.markup"), tip: t("review.view.markupTip") },
            { value: "final", label: t("review.view.final"), tip: t("review.view.finalTip") },
          ]}
        />
        <label className={cx("rv-track", tracking && "on")} title={t("review.trackTip")}>
          <input type="checkbox" checked={tracking} onChange={(e) => setTrackingNow(e.target.checked)} />
          <span>{t("review.track")}</span>
        </label>
        <div className="rv-actions">
          <button type="button" className="btn btn-sm" onMouseDown={(e) => e.preventDefault()} onClick={() => startComment()} title={t("review.newCommentTip")}>
            {t("review.newComment")}
          </button>
          <button type="button" className="btn btn-sm" disabled={!changes.length} onClick={() => resolveDoc(true)}>
            {t("review.acceptAll")}
          </button>
          <button type="button" className="btn btn-sm" disabled={!changes.length} onClick={() => resolveDoc(false)}>
            {t("review.rejectAll")}
          </button>
        </div>
      </Section>
      {composer?.mode === "new" && (
        <Section title={t("review.newComment")}>
          <ComposerBox quote={composer.quote} label={t("review.commentLabel")} />
        </Section>
      )}
      {!comments.length && !changes.length ? (
        <div className="empty-state small">
          <p>{t("review.empty")}</p>
        </div>
      ) : (
        <>
          <Section title={`${t("review.comments")} · ${comments.length}`}>
            {threads.length ? (
              <ul className="rv-list">
                {threads.map(({ c, replies }) => (
                  <CommentCard key={c.id} c={c} replies={replies} quote={commentedText(paras, c.id)} />
                ))}
              </ul>
            ) : (
              <p className="rv-none">{t("review.noComments")}</p>
            )}
          </Section>
          <Section title={`${t("review.changes")} · ${changes.length}`}>
            {changes.length ? (
              <ul className="rv-list">
                {changes.map((ch, i) => (
                  <ChangeRow key={i} ch={ch} />
                ))}
              </ul>
            ) : (
              <p className="rv-none">{t("review.noChanges")}</p>
            )}
          </Section>
        </>
      )}
      <p className="rv-note">{t("review.editNote3")}</p>
    </div>
  );
}
