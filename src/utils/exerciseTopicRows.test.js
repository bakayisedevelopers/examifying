import assert from 'node:assert/strict';
import test from 'node:test';
import { getQuestionPaperPath } from './exerciseTopicRows.js';

test('question paper links can be resolved into the selected parent student workspace', () => {
  const parentStudentPath = (path) => path.replace(/^\/student(?=\/|$)/, '/parent/kids/student-123');

  assert.equal(
    getQuestionPaperPath({
      paperId: 'paper-456',
      pageNumber: 3,
      questionReference: '2.1(b)',
    }, 'student', parentStudentPath),
    '/parent/kids/student-123/papers/paper-456?page=3&question=2.1%28b%29',
  );
});

test('question paper links preserve existing role routes when no resolver is supplied', () => {
  assert.equal(
    getQuestionPaperPath({ paperId: 'paper-456', pageNumber: 2 }, 'student'),
    '/student/papers/paper-456?page=2',
  );
  assert.equal(
    getQuestionPaperPath({ paperId: 'paper-456' }, 'tutor'),
    '/tutor/papers/paper-456?page=1',
  );
});
