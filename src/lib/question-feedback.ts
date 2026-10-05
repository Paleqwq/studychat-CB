// Some providers double-escape JSON reply newlines, leaving visible characters
// after JSON.parse. Normalize feedback prose, never student answers or evidence.
export function normalizeQuestionFeedback(feedback: string): string {
  const protectedText = /(`+)[\s\S]*?\1|(~{3,})[\s\S]*?\2|(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>"'`，。；！？]+|(?:[a-z]:\\|\\\\|\.{1,2}[\\/])[^\s<>"'`]+|\]\((?:\\.|[^)])*\)|["'“‘](?:(?:\\r\\n|\\n|\/n)+)["'”’]/gi;
  const prose = (text: string) => text.replace(/(?:\\r\\n|\\n|\/n(?![a-z\d_]))/g, "\n");
  let result = "";
  let start = 0;
  for (const match of feedback.matchAll(protectedText)) {
    result += prose(feedback.slice(start, match.index)) + match[0];
    start = match.index! + match[0].length;
  }
  return result + prose(feedback.slice(start));
}

// Saved messages can also contain a program-generated question. Only repair
// the preceding feedback; the frozen question text and stored record stay intact.
export function questionMessageFeedback(content: string): string {
  const heading = content.search(/^### 第 [1-3] 题 \/ 3：/m);
  return heading < 0 ? normalizeQuestionFeedback(content) :
    normalizeQuestionFeedback(content.slice(0, heading)) + content.slice(heading);
}
