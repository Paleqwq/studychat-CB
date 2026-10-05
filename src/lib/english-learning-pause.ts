export const ENGLISH_PAUSE_MESSAGE = "可以先休息一下。本次学习已暂停，当前题目和进度已保留。准备好后，点击“继续学习”即可从这里继续。";
export const ENGLISH_RESUME_MESSAGE = "欢迎回来，学习已继续。请接着完成暂停前的当前活动。";

/** Recognize a request to stop learning, rather than diagnosing an emotion. */
export function isEnglishLearningPauseRequest(answer: string): boolean {
  const text = answer.normalize("NFKC").toLowerCase().replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ")
    .replace(/^[ \t]*>[^\n]*/gm, " ")
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|«[^»]*»|"[^"\n]*"/g, " ")
    .replace(/'[^'\n]*[\u3400-\u9fff][^'\n]*'/g, " ")
    .replace(/^[ \t]*(?:p|e1|e2|c|point|evidence|explanation|connection|英文段落|英文正文|正文|结构说明|结构标注)\s*[:：][^\n]*/gm, " ")
    .replace(/’/g, "'");
  const chinese = /(?:不想|不愿意)(?:再|继续|接着)?(?:学习|学英语|学|做题|答题|回答|练习|写)(?:了|下去(?:了)?|(?=$|\s))|(?:不想|不愿意)(?:再)?(?:继续|再学)(?:了)?|(?:先|暂时|今天)(?:不学|不做题|不答题)(?:了)?|(?:学|做|答|写)不下去(?:了)?|不(?:学|做题|答题|做|答|写)了|没(?:有)?心情(?:学(?:习|英语)?|做题|答题)|暂停(?:学习|会话|课程|做题|答题)?(?:一下|一会儿?|下)?(?=$|\s)|停止(?:学习|学英语|会话|课程|做题|答题)(?:一下|一会儿?|下)?|(?:我想|我要|我需要|让我|先)(?:休息|歇)(?:一下|一会儿?)|休息一下|(?:别|不要)再(?:问|提问|出题)(?:了)?/g;
  const english = /\bi\s+(?:(?:don't|do not|no longer)\s+want\s+to\s+(?:(?:continue|keep)\s+)?(?:study|learn|practice|answer)|(?:want|need|would like)\s+to\s+(?:(?:stop|pause)(?:\s+(?:learning|studying|practicing|answering|the lesson|this session))?|take\s+a\s+break))\b|\bi\s+need\s+a\s+break\b|\b(?:let's|can we|could we|please)\s+(?:(?:pause|stop)(?:\s+(?:learning|studying|the lesson|this session))?|take\s+a\s+break)\b|^(?:please\s+)?(?:stop|pause)(?:\s+(?:learning|studying|the lesson|this session))?$|^take\s+a\s+break$/g;
  let offset = 0; let pauseAt = -1;
  for (const rawClause of text.split(/[。！？!?；;\n,，]/)) {
    const clause = rawClause.trim();
    // Quoted, hypothetical and translation tasks describe these words rather
    // than giving permission to pause the student's own learning session.
    if (!/(?:如果|假如|假设|要是|比如|例如|翻译|译成|是什么意思|怎么说|怎么翻译|what does|translate|translation|for example|\bif\b)/.test(clause)) {
      for (const pattern of [chinese, english]) {
        pattern.lastIndex = 0;
        for (let match = pattern.exec(clause); match; match = pattern.exec(clause)) {
          const prefix = clause.slice(0, match.index);
          const suffix = clause.slice(match.index + match[0].length);
          if (/(?:不是|不是说|并非|并不|没有说|没说|不代表|不等于|不想|不要|not saying|never said)\s*.{0,4}$/.test(prefix)) continue;
          if (/(?:就说|可以说|要说|写出|包含|出现|提到|这句话是)\s*.{0,4}$/.test(prefix)) continue;
          if (/^(?:的意思|是什么意思|这句话|这个词|功能|按钮)/.test(suffix.trim())) continue;
          if (/(?:学生|别人|他|她|同学|老师|教师|助教)(?:说|表示|提到|建议|认为|觉得).{0,12}$/.test(prefix)) continue;
          if (/\b(?:teacher|student|he|she)\s+(?:says|said|asks)\s*.{0,12}$/.test(prefix)) continue;
          if (pattern === english && /(?:stop|pause)$/.test(match[0]) && suffix.trim()
            && !/^[\s.!]*(?:$|now\b|for now\b|for today\b|because\b|please\b)/.test(suffix)) continue;
          if (pattern === english && /break$/.test(match[0]) && /^\s*from\s+(?!learning\b|studying\b|the lesson\b|this session\b)/.test(suffix)) continue;
          pauseAt = offset + match.index;
        }
      }
    }
    offset += rawClause.length + 1;
  }
  if (pauseAt < 0) return false;
  // A later explicit decision to continue takes precedence over reluctance.
  const continuation = /(?:还是|仍然|但(?:是)?我|不过我)(?:还)?(?:想|要|愿意)?(?:继续|接着)(?:学(?:习)?|做题|答题|练习)?|我(?:还)?(?:想|要|愿意)(?:继续|接着)(?:学(?:习)?|做题|答题|练习)|(?:^|[,，。])\s*(?:继续|接着)(?:学(?:习)?|做题|答题|练习)|\bbut\s+i\s+(?:want to|will|would like to)\s+continue\b/g;
  return !Array.from(text.matchAll(continuation)).some(match => {
    const at = match.index ?? 0;
    return at > pauseAt && !/(?:如果|假如|假设|要是|明天|以后|下次|稍后|等会|将来|\bif\b|tomorrow|later|next time)/.test(text.slice(pauseAt, at));
  });
}
