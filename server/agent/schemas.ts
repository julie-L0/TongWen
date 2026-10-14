import { fail } from '../domain/rules.ts';
type Schema = {
  description?: string;
  type: 'object' | 'array' | 'string' | 'integer';
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
  additionalProperties?: false;
};
const text = (maxLength = 1500): Schema => ({ type: 'string', maxLength });
const list = (items: Schema, maxItems = 32, minItems = 1): Schema => ({
  type: 'array',
  items,
  minItems,
  maxItems,
});
const ids = (max = 32, min = 1) => list(text(100), max, min);
const number = (minimum: number, maximum: number): Schema => ({ type: 'integer', minimum, maximum });
const choice = (...values: string[]): Schema => ({ type: 'string', enum: values });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const quote = object({ evidenceId: text(100), quote: text(30000) });
const reviewQuote = object({ evidenceId: text(100), quote: text(30000) }, ['quote']);
const patch = object(
  {
    kind: choice('replace_text', 'insert_block', 'remove_block'),
    blockId: text(100),
    refId: { ...text(100), description: '可用真实目标refId替代物理blockId，由程序解析。' },
    before: text(30000),
    after: text(30000),
    afterBlockId: text(100),
    afterRefId: { ...text(100), description: '插入时可用真实已读目标refId替代物理afterBlockId。' },
    block: object({ kind: choice('paragraph', 'list_item'), text: text(30000) }),
    expectedText: text(30000),
  },
  ['kind'],
);
const definitions: Record<string, { description: string; parameters: Schema }> = {
  list_fragments: {
    description:
      '分页列出冻结范围内正文和标题目录。目录不算读取。refId 是本任务真实引用，不能伪造。limit 最大 50。',
    parameters: object(
      {
        memberId: text(100),
        role: choice('anchor', 'sync', 'history'),
        cursor: number(0, 10000),
        limit: number(1, 50),
      },
      [],
    ),
  },
  search_fragments: {
    description:
      '仅在允许范围用业务对象或表达搜索，返回摘录和 refId。搜索不是证据；需要 read_context。零命中不等于无影响。',
    parameters: object(
      {
        query: text(200),
        memberId: text(100),
        role: choice('anchor', 'sync', 'history'),
        cursor: number(0, 10000),
        limit: number(1, 30),
      },
      ['query'],
    ),
  },
  read_context: {
    description:
      '读真实完整块和相邻内容，登记 evidenceId。每次最多 12 个 refIds，neighborDepth 为 0–3。包括来源变化前后、底本和目标。已有证据可复用，历史不参与同步。',
    parameters: object({ refIds: ids(12), neighborDepth: number(0, 3) }, ['refIds']),
  },
  describe_change: {
    description:
      '创建变化必须省略 changeId，程序返回真实 C 编号。只有修订已成功创建的变化才传 changeId；失败调用不创建任何编号。before 仅引用所选 delta 的基线证据，after 仅引用当前证据；新增 before 可为空。同一业务多处表达合并 deltaIds。',
    parameters: object({
      changes: list(
        object(
          {
            changeId: {
              ...text(100),
              description: '创建时省略。修订时只填写执行器此前成功返回的真实 changeId；不能自己猜 C1。',
            },
            supersedes: {
              ...ids(12, 0),
              description:
                '可选。多个已有变化属于同一业务时，列出被合并的真实 C 编号；deltaIds 必须覆盖其全部 delta，相关判断重新核对。',
            },
            deltaIds: ids(),
            kind: choice('add', 'remove', 'rule', 'terminology', 'editorial', 'unknown'),
            businessObject: text(200),
            summary: text(),
            before: list(quote, 12, 0),
            after: list(quote, 12, 0),
          },
          ['deltaIds', 'kind', 'businessObject', 'summary', 'before', 'after'],
        ),
        12,
      ),
    }),
  },
  record_relation: {
    description:
      '记录变化与目标的一对多／多对一语义关系，绑定原文证据。complete/ selective/unknown 来自目标真实用途，不能仅由功能数量推断完整覆盖。',
    parameters: object(
      {
        changeIds: ids(12),
        targetRefIds: ids(24),
        type: choice('equivalent', 'summary_of', 'implements', 'feature_set', 'ambiguous'),
        coverageMode: choice('complete', 'selective', 'unknown'),
        evidenceIds: ids(48),
        reason: text(),
      },
      ['changeIds', 'targetRefIds', 'type', 'coverageMode', 'reason'],
    ),
  },
  record_finding: {
    description:
      '每批最多12条Change×正文判断。建议省略evidenceIds，由程序绑定已读来源／目标／必需出处，未读仍拒绝；显式给出的编号严格验证。needs_update可内联relation声明类型、覆盖意图及理由，不需另抄L编号。底本仅not_conflicting/conflict/uncertain，同步用needs_update/already_current/compatible/unrelated/uncertain。',
    parameters: object({
      findings: list(
        object(
          {
            changeId: text(100),
            refId: text(100),
            status: choice(
              'needs_update',
              'already_current',
              'compatible',
              'unrelated',
              'uncertain',
              'not_conflicting',
              'conflict',
            ),
            evidenceIds: ids(48),
            relationIds: ids(24, 0),
            relation: object(
              {
                type: choice('equivalent', 'summary_of', 'implements', 'feature_set', 'ambiguous'),
                coverageMode: choice('complete', 'selective', 'unknown'),
                reason: text(500),
                targetRefIds: ids(24),
                evidenceIds: ids(48),
              },
              ['type', 'coverageMode', 'reason'],
            ),
            reason: text(500),
            scopeBasis: choice('current_source', 'source_exception', 'needs_definition'),
            scopeWitness: quote,
            auditVerdict: choice('checked'),
          },
          ['changeId', 'refId', 'status', 'reason'],
        ),
        12,
      ),
    }),
  },
  propose_patch: {
    description:
      '只创建提案，不写文件。先核对底本并登记needs_update。补丁建议用refId／afterRefId，程序解析物理ID；before仍是唯一真实锚点。省略evidenceIds时绑定实际已读证据，插入边界也须已读。仍支持明确blockId与evidenceIds，伪造或不一致拒绝。不要生成新块ID。',
    parameters: object(
      {
        changeId: text(100),
        targetRefIds: ids(24),
        patches: list(patch, 12),
        evidenceIds: ids(48),
        reason: text(),
      },
      ['changeId', 'targetRefIds', 'patches', 'reason'],
    ),
  },
  finish_task: {
    description:
      '请求结束。程序校验所有来源 delta 和 Change×底本／同步正文覆盖；未解决必须用 uncertain 或 unresolved 报告，不把没找到当无影响。needs_update 必须有提案或定位失败解释。',
    parameters: object(
      {
        summary: text(3000),
        unresolved: list(object({ changeId: text(100), refId: text(100), reason: text(),
          questions: { ...list(text(300), 5), description: 'scoped-v1缺证必须给针对真实缺项的可回答问题，不能只说待确认。' },
          relatedRefIds: { ...ids(12), description: '同一缺证的已读邻近正文，含uncertain或compatible/unrelated出处说明；同变化/文档/章节，不能跨文档。' },
        }, ['changeId', 'refId', 'reason']), 100, 0),
      },
      ['summary'],
    ),
  },
  review_document: {
    description:
      '目标文档整体复核。读取该文档完整正文并完成逐片段判断后，将新规则的必要条件逐项与现有正文或实际提案核对，交代所有变化和有效提案；检查表格／正文一致、遗漏、用途段重复及附带损坏。复核前先修正判断或补丁。原文不会写入，语义结论仍需独立评分。',
    parameters: object(
      {
        memberId: {
          ...text(100),
          description:
            '使用focus.memberId或真实目录memberId，不是refId/blockId。只复核sync目标，来源／底本／历史不提交。',
        },
        evidenceIds: ids(64),
        mode: { ...choice('append', 'finalize', 'exclude_document'), description: 'append保存小批检查；finalize汇总。scoped-v1可exclude_document：全文已读、明确精选且整文与全部变化无关时，记录一次整文排除；不能掩盖相关规则或已有修改。' },
        purpose: object({ kind: choice('acceptance', 'procedure', 'overview', 'selected', 'other'), refId: text(100), quote: text(1500) }),
        exclusionReason: text(500),
        checks: list(
          object(
            {
              changeId: text(100),
              source: reviewQuote,
              obligationId: { ...text(100), description: '来源条款协议使用changes.obligations中的真实编号；每个来源条件/例外分别复核，不猜编号。' },
              obligationIds: { ...ids(24), description: 'scoped-v1可合并多个真实条款，但同一实际目标见证必须完整承载各条所有条件。与obligationId二选一，不能靠省略条件缩减检查。' },
              targetWitness: object({ mode: choice('present', 'absent'), quote: text(3000) }),
              scope: { ...choice('fragment', 'document'), description: 'not_applicable默认只说明片段不需改，不能计作整文条款覆盖。scoped-v1整文排除需scope=document及真实用途；完整验收/操作不能这样排除行为条款。' },
              targetRefIds: ids(24),
              proposalIds: ids(24, 0),
              outcome: choice('patched', 'current', 'not_applicable', 'unresolved'),
              reason: text(1000),
            },
            ['changeId', 'targetRefIds', 'outcome', 'reason'],
          ),
          64, 0,
        ),
      },
      ['memberId', 'checks'],
    ),
  },
};
export const toolSchemas = Object.entries(definitions).map(([name, value]) => ({
  type: 'function',
  function: { name, ...value },
}));
export function validateTool(name: string, args: unknown, options: { scopedQuoteBinding?: boolean } = {}) {
  const def = definitions[name];
  if (!def) fail('UNKNOWN_TOOL', '工具不在允许列表中。');
  function check(s: Schema, v: any, p: string) {
    if (s.type === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) fail('INVALID_ARGUMENT', `${p} 必须是对象。`);
      for (const k of s.required || []) if (v[k] === undefined) fail('INVALID_ARGUMENT', `${p}.${k} 缺失。`, 400, {
        field: `${p}.${k}`, requiredFields: s.required, allowedFields: Object.keys(s.properties || {}), committed: false,
      });
      for (const k of Object.keys(v)) {
        if (!s.properties?.[k]) fail('INVALID_ARGUMENT', `${p}.${k} 不允许。`, 400, {
          field: `${p}.${k}`, allowedFields: Object.keys(s.properties || {}), committed: false,
        });
        check(s.properties![k], v[k], `${p}.${k}`);
      }
    }
    if (s.type === 'array') {
      if (!Array.isArray(v) || v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? 100))
        fail(
          'INVALID_ARGUMENT',
          `${p} 数量无效：每批允许 ${s.minItems ?? 0}–${s.maxItems ?? 10000} 条，实际 ${Array.isArray(v) ? v.length : '非数组'}；请拆分批次后重试。本次未提交。`,
          400,
          {
            field: p,
            minItems: s.minItems ?? 0,
            maxItems: s.maxItems ?? 10000,
            actualItems: Array.isArray(v) ? v.length : null,
            committed: false,
          },
        );
      v.forEach((a: unknown, i: number) => check(s.items!, a, `${p}[${i}]`));
    }
    if (
      s.type === 'string' &&
      (typeof v !== 'string' || v.length > (s.maxLength ?? 30000) || (s.enum && !s.enum.includes(v)))
    )
      fail('INVALID_ARGUMENT', `${p} 字符串或选项无效。${s.enum ? '合法选项：'+s.enum.join('、')+'。' : ''}`, 400, {
        field: p, ...(s.enum ? { allowedValues: s.enum, actualValue: typeof v === 'string' ? v.slice(0, 200) : typeof v } : {}),
        maxLength: s.maxLength ?? 30000, committed: false,
      });
    if (
      s.type === 'integer' &&
      (!Number.isSafeInteger(v) || v < (s.minimum ?? 0) || v > (s.maximum ?? 10000))
    )
      fail('INVALID_ARGUMENT', `${p} 数值无效。`);
  }
  const parameters = options.scopedQuoteBinding && name === 'review_document' ? structuredClone(def.parameters) : def.parameters;
  if (options.scopedQuoteBinding && name === 'review_document') {
    const purpose = parameters.properties!.purpose;
    purpose.required = purpose.required?.filter(key => key !== 'quote');
    const witness = parameters.properties!.checks.items!.properties!.targetWitness;
    witness.required = witness.required?.filter(key => key !== 'quote');
  }
  check(parameters, args, name);
}
