import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, LoaderCircle, RefreshCw } from 'lucide-react';
import { InAppPdfPage } from '../components/common/InAppPdfPage';
import { getPublicQuestionPaperById } from '../services/publicQuestionPaperService';

export const PublicPaperReaderPage = () => {
  const { paperId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [paper, setPaper] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryVersion, setRetryVersion] = useState(0);
  const documentType = searchParams.get('document') === 'memo' ? 'memo' : 'paper';
  const documentUrl = documentType === 'memo' ? paper?.memoUrl : paper?.paperUrl;
  const pageNumber = Math.max(1, Number(searchParams.get('page') ?? 1) || 1);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setPaper(null);

    getPublicQuestionPaperById(paperId).then((result) => {
      if (!active) return;
      if (!result) {
        setError('This public past paper could not be found.');
        return;
      }
      setPaper(result);
      if (result.slug && result.slug !== paperId) {
        navigate({ pathname: `/papers/${result.slug}`, search: location.search }, { replace: true });
      }
    }).catch((loadError) => {
      if (active) setError(loadError?.message || 'Public paper information could not be loaded.');
    }).finally(() => {
      if (active) setLoading(false);
    });

    return () => { active = false; };
  }, [location.search, navigate, paperId, retryVersion]);

  const updatePage = (nextPage) => {
    const next = new URLSearchParams(searchParams);
    next.set('page', String(Math.max(1, Math.floor(Number(nextPage) || 1))));
    setSearchParams(next, { replace: true });
  };

  const retry = () => setRetryVersion((value) => value + 1);
  const title = documentType === 'memo' ? 'Memorandum' : 'Question paper';
  const paperTitle = paper?.displayName || `${paper?.subject || 'Question paper'} ${paper?.grade || ''}`.trim();

  return (
    <main className="fixed inset-0 z-50 flex h-[100dvh] flex-col bg-slate-950 text-white">
      <header className="grid h-14 shrink-0 grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-2 px-3 sm:px-5">
        <button type="button" className="grid h-10 w-10 place-items-center rounded-full border border-slate-700 bg-slate-950 text-lime-300" onClick={() => navigate('/papers')} aria-label="Back to past papers">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <p className="min-w-0 truncate rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-center text-sm font-semibold text-lime-200">
          {paper ? `${paperTitle} · ${title}` : 'Past paper'}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className="grid h-9 w-9 place-items-center rounded-full border border-slate-700 text-lime-300 disabled:opacity-40" onClick={() => updatePage(pageNumber - 1)} disabled={pageNumber <= 1} aria-label="Previous PDF page">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="min-w-14 text-center text-xs text-slate-300">Page {pageNumber}</span>
          <button type="button" className="grid h-9 w-9 place-items-center rounded-full border border-slate-700 text-lime-300" onClick={() => updatePage(pageNumber + 1)} aria-label="Next PDF page">
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </header>

      {paper ? (
        <section className="shrink-0 border-b border-slate-800 bg-slate-900 px-4 py-3 sm:px-6" aria-label="Public past paper details">
          <h1 className="text-sm font-bold sm:text-base">{paperTitle}</h1>
          <p className="mt-1 text-xs leading-5 text-slate-300 sm:text-sm">
            Subject: {paper.subject || 'Not listed'} · Grade: {paper.grade || 'Not listed'} · Year: {paper.year || 'Not listed'} · Month: {paper.month || 'Not listed'} · Province or region: {paper.region || 'Not listed'} · Paper: {paper.paperNumber || 'Not listed'} · {paper.memoAvailable ? 'Memo available' : 'Memo not listed'}
          </p>
        </section>
      ) : null}

      {loading ? (
        <div role="status" className="grid min-h-0 flex-1 place-items-center p-6 text-center text-sm text-slate-200">
          <span className="inline-flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin text-lime-400" aria-hidden="true" />Loading paper…</span>
        </div>
      ) : error ? (
        <div role="alert" className="grid min-h-0 flex-1 place-items-center p-6 text-center text-sm text-slate-200">
          <div className="max-w-md space-y-4">
            <p>{error}</p>
            <div className="flex flex-wrap justify-center gap-3">
              <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={retry}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />Try again
              </button>
              <button type="button" className="btn-primary" onClick={() => navigate('/papers')}>Back to papers</button>
            </div>
          </div>
        </div>
      ) : !documentUrl ? (
        <div role="status" className="grid min-h-0 flex-1 place-items-center p-6 text-center text-sm text-slate-200">
          This {title.toLowerCase()} is not available.
        </div>
      ) : (
        <InAppPdfPage url={documentUrl} pageNumber={pageNumber} className="flex-1 bg-slate-800 p-2 sm:p-4" />
      )}
    </main>
  );
};
