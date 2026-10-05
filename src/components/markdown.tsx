"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ children }: { children: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={["img"]}
    components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a> }}>
    {children}
  </ReactMarkdown></div>;
}
