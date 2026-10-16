import test from 'node:test';
import assert from 'node:assert/strict';
import { excludeDuplicateImageReferences, imageReferenceIdentity } from './imageReferences.js';

test('normalizes Firebase Storage image URLs independently of download tokens', () => {
  const first = { url: 'https://firebasestorage.googleapis.com/v0/b/examifying.firebasestorage.app/o/users%2Fstudent%2Fpeer-reviews%2Fpage-1.png?alt=media&token=old' };
  const refreshed = { url: 'https://firebasestorage.googleapis.com/v0/b/examifying.firebasestorage.app/o/users%2Fstudent%2Fpeer-reviews%2Fpage-1.png?alt=media&token=new' };
  assert.equal(imageReferenceIdentity(first), imageReferenceIdentity(refreshed));
});

test('hides an image repeated across the AI-reviewed and peer-marked display fields', () => {
  const aiReviewed = [
    { url: 'https://firebasestorage.googleapis.com/v0/b/examifying.firebasestorage.app/o/peer-reviews%2Fmarked-1.png?token=ai' },
  ];
  const rawPeerMarked = [
    { url: 'https://firebasestorage.googleapis.com/v0/b/examifying.firebasestorage.app/o/peer-reviews%2Fmarked-1.png?token=raw' },
    { url: 'https://firebasestorage.googleapis.com/v0/b/examifying.firebasestorage.app/o/peer-reviews%2Fmarked-2.png?token=raw' },
  ];
  assert.deepEqual(excludeDuplicateImageReferences(aiReviewed, rawPeerMarked), [rawPeerMarked[1]]);
});

test('preserves peer-marked pages that do not duplicate the AI-reviewed page', () => {
  const aiReviewed = [{ storagePath: 'peer-reviews/marked-page-1.png' }];
  const peerMarked = [{ storagePath: 'peer-reviews/marked-page-2.png' }];
  assert.deepEqual(excludeDuplicateImageReferences(aiReviewed, peerMarked), peerMarked);
});
