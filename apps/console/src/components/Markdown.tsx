import ReactMarkdown, { type Components } from "react-markdown";

const safeHref = (href?: string) => (href && /^(https:\/\/|\/(?!\/)|#)/.test(href) ? href : undefined);

const components: Components = {
  a: ({ href, children }) => {
    const h = safeHref(href);
    return h ? (
      <a href={h} rel="noreferrer noopener" target={h.startsWith("https://") ? "_blank" : undefined}>
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
};

/**
 * Markdown from apps and models. No raw HTML, no images (they could carry data out in a URL),
 * and only https or same-site links.
 */
export const Markdown = ({ text }: { text: string }) => (
  <div className="prose">
    <ReactMarkdown skipHtml disallowedElements={["img", "script", "iframe", "style"]} unwrapDisallowed components={components}>
      {text}
    </ReactMarkdown>
  </div>
);
