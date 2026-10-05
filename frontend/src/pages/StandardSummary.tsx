import { AiReferenceBadge } from '../components/AiReferenceBadge';
import { Link } from 'react-router-dom';
import type { StandardCitation, StandardVersion } from '../api/simplification';

export function StandardSummary({ standard, projectId }: { standard: StandardVersion; projectId: string }) {
  const references: Array<{ key: string; citation: StandardCitation }> = [];
  const rows = standard.rubric.weights.map(weight => {
    const numbers = new Set<number>();
    for (const requirement of standard.requirements.filter(requirement => standard.mappings.some(mapping => mapping.requirementId === requirement.requirementId && mapping.dimensionKey === weight.key))) {
      for (const citation of requirement.citations) {
        const key = citation.fileId ?? citation.sourceVersionId ?? citation.fragmentId;
        let index = references.findIndex(reference => reference.key === key);
        if (index < 0) { references.push({ key, citation }); index = references.length - 1; }
        numbers.add(index + 1);
      }
    }
    return { weight, numbers: [...numbers] };
  });
  const anchor = (number: number) => `standard-${standard.standardsVersionId}-reference-${number}`;
  return <section className="stack standard-summary" aria-label="评分比例与参考资料">
    {rows.map(({ weight, numbers }) => <p key={weight.key}>{weight.label} · 权重 {weight.weight}%<AiReferenceBadge ariaHidden />{numbers.map(number => <sup key={number}><a href={`#${anchor(number)}`} aria-label={`参考资料 ${number}`}>[{number}]</a></sup>)}</p>)}
    {references.length > 0 && <ol className="standard-references">{references.map(({ key, citation }, index) => {
      const name = citation.fileName ?? citation.sourceTitle ?? '';
      const title = citation.availability === 'unavailable' ? '原始来源不可用，历史引用保留' : citation.archivedAt ? '归档资料，固定版本只读' : name;
      const target = citation.fileId ? `/api/v1/projects/${projectId}/files/${citation.fileId}/content` : citation.sourceId ? `/app/projects/${projectId}/data?resourceType=source&resourceId=${encodeURIComponent(citation.sourceId)}&sourceVersionId=${encodeURIComponent(citation.sourceVersionId ?? '')}` : null;
      return <li key={key} id={anchor(index + 1)}>{target && citation.availability !== 'unavailable' ? target.startsWith('/api/') ? <a href={target} download={name} title={title}>[{index + 1}] {name}</a> : <Link to={target} title={title}>[{index + 1}] {name}</Link> : <span title={title}>[{index + 1}] {name}</span>}<AiReferenceBadge ariaHidden /></li>;
    })}</ol>}
  </section>;
}
