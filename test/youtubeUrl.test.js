const { parseYouTubeUrl } = require('../compiled/youtubeUrl.js');

const cases = [
  {
    name: 'normal watch URL',
    url: 'https://www.youtube.com/watch?v=LeRylkDym54',
    expected: { success: true, videoId: 'LeRylkDym54' }
  },
  {
    name: 'watch URL with additional query parameter',
    url: 'https://www.youtube.com/watch?v=LeRylkDym54&t=120',
    expected: { success: true, videoId: 'LeRylkDym54' }
  },
  {
    name: 'non YouTube URL',
    url: 'https://example.com/watch?v=LeRylkDym54',
    expected: { success: false, error: 'Active tab is not YouTube' }
  },
  {
    name: 'YouTube homepage',
    url: 'https://www.youtube.com/',
    expected: { success: false, error: 'YouTube page is not a watch page' }
  },
  {
    name: 'watch without video id',
    url: 'https://www.youtube.com/watch',
    expected: { success: false, error: 'YouTube watch page has no video ID' }
  },
  {
    name: 'watch with empty video id',
    url: 'https://www.youtube.com/watch?v=',
    expected: { success: false, error: 'YouTube watch page has no video ID' }
  }
];

for (const testCase of cases) {
  const actual = parseYouTubeUrl(testCase.url);
  if (actual.success !== testCase.expected.success) {
    throw new Error(`${testCase.name}: expected success=${testCase.expected.success} got success=${actual.success}`);
  }

  if (testCase.expected.success) {
    if (actual.videoId !== testCase.expected.videoId) {
      throw new Error(`${testCase.name}: expected videoId=${testCase.expected.videoId} got videoId=${actual.videoId}`);
    }
  } else if (actual.error !== testCase.expected.error) {
    throw new Error(`${testCase.name}: expected error=${testCase.expected.error} got error=${actual.error}`);
  }
}

console.log('youtubeUrl tests passed:', cases.length);
