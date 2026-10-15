import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPublicPaperStructuredData,
  getPublicPaperSeo,
  getRouteSeo,
} from '../src/config/seo.js';

const portals = {
  student: 'https://examifying.bakayise.com',
  parent: 'https://parents.examifying.bakayise.com',
  tutor: 'https://tutors.examifying.bakayise.com',
  teacher: 'https://teachers.examifying.bakayise.com',
};
const paper = {
  subject: 'Life Sciences',
  grade: 'Grade 10',
  year: 2025,
  paperUrl: 'https://firebasestorage.googleapis.com/v0/b/examifying.firebasestorage.app/o/questionPapers%2Fpublic%2Fpaper.pdf?alt=media',
};

test('each public portal receives matching catalog, paper, canonical, and structured-data URLs', () => {
  for (const [portal, origin] of Object.entries(portals)) {
    const catalog = getRouteSeo('/papers', portal);
    assert.equal(catalog.url, `${origin}/papers`);
    assert.equal(catalog.indexable, true);

    const detail = getRouteSeo('/papers/paper-123', portal);
    assert.equal(detail.url, `${origin}/papers/paper-123`);

    const paperSeo = getPublicPaperSeo(paper, 'paper-123', portal);
    assert.equal(paperSeo.url, `${origin}/papers/paper-123`);
    const structuredData = buildPublicPaperStructuredData(paperSeo, portal);
    assert.equal(structuredData['@graph'][0].url, `${origin}/`);
    assert.equal(structuredData['@graph'][2].itemListElement[1].item, `${origin}/papers`);
  }
});

test('admin remains noindex for paper routes', () => {
  assert.equal(getRouteSeo('/papers', 'admin').indexable, false);
  assert.equal(getRouteSeo('/papers/paper-123', 'admin').indexable, false);
});
