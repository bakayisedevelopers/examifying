export const slugifyPublicPaperName = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 90)
  .replace(/-+$/g, '') || 'past-paper';

export const getPublicPaperSlug = (paper = {}, paperId = paper.id) => {
  const id = String(paperId ?? '').trim();
  const displayName = paper.displayName || paper.paperTitle || [
    paper.subject,
    paper.grade,
    paper.month,
    paper.year,
    paper.region || paper.province,
    paper.paperNumber,
  ].filter(Boolean).join(' ');
  const titleSlug = slugifyPublicPaperName(displayName);
  return id ? `${titleSlug}--id--${id}` : titleSlug;
};
