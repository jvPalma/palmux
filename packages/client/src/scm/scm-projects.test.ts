import { describe, expect, it } from 'vitest';
import { addScmProject } from './scm-projects';

describe('addScmProject', () => {
  it('appends a new top and makes it the active project', () => {
    expect(addScmProject({ scmRepos: ['/work/a'] }, '/work/b')).toEqual({
      scmRepos: ['/work/a', '/work/b'],
      scmActiveRepo: '/work/b',
    });
  });

  it('only makes an existing top active, leaving the list alone', () => {
    expect(addScmProject({ scmRepos: ['/work/a', '/work/b'] }, '/work/a')).toEqual({
      scmActiveRepo: '/work/a',
    });
  });

  it('does not add another spelling of a top that is already listed', () => {
    expect(addScmProject({ scmRepos: ['/work/a'] }, '/work//a/')).toEqual({
      scmActiveRepo: '/work/a',
    });
  });

  it('stores the canonical spelling of a new top', () => {
    expect(addScmProject({ scmRepos: [] }, '/work/./b/')).toEqual({
      scmRepos: ['/work/b'],
      scmActiveRepo: '/work/b',
    });
  });

  it('changes nothing for a path that is not absolute', () => {
    expect(addScmProject({ scmRepos: ['/work/a'] }, 'work/a')).toEqual({});
  });
});
