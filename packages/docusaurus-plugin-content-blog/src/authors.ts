/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import _ from 'lodash';
import {getDataFileData, normalizeUrl} from '@docusaurus/utils';
import {Joi, URISchema} from '@docusaurus/utils-validation';
import {AuthorSocialsSchema, normalizeSocials} from './authorsSocials';
import type {BlogContentPaths} from './types';
import type {
  Author,
  BlogPost,
  BlogPostFrontMatter,
  BlogPostFrontMatterAuthor,
} from '@docusaurus/plugin-content-blog';

export type AuthorsMap = {[authorKey: string]: Author};

const AuthorsMapSchema = Joi.object<AuthorsMap>()
  .pattern(
    Joi.string(),
    Joi.object<Author>({
      name: Joi.string(),
      url: URISchema,
      imageURL: URISchema,
      title: Joi.string(),
      email: Joi.string(),
      socials: AuthorSocialsSchema,
    })
      .rename('image_url', 'imageURL')
      .or('name', 'imageURL')
      .unknown()
      .required()
      .messages({
        'object.base':
          '{#label} should be an author object containing properties like name, title, and imageURL.',
        'any.required':
          '{#label} cannot be undefined. It should be an author object containing properties like name, title, and imageURL.',
      }),
  )
  .messages({
    'object.base':
      "The authors map file should contain an object where each entry contains an author key and the corresponding author's data.",
  });

export function validateAuthorsMap(content: unknown): AuthorsMap {
  const {error, value} = AuthorsMapSchema.validate(content);
  if (error) {
    throw error;
  }
  return value;
}

function normalizeSocialAuthor(author: Author): Author {
  return {
    ...author,
    socials: author.socials ? normalizeSocials(author.socials) : undefined,
  };
}

function normalizeAuthorsMap(authorsMap: AuthorsMap): AuthorsMap {
  return _.mapValues(authorsMap, normalizeSocialAuthor);
}

export async function getAuthorsMap(params: {
  authorsMapPath: string;
  contentPaths: BlogContentPaths;
}): Promise<AuthorsMap | undefined> {
  const authorsMap = await getDataFileData(
    {
      filePath: params.authorsMapPath,
      contentPaths: params.contentPaths,
      fileType: 'authors map',
    },
    // TODO annoying to test: tightly coupled FS reads + validation...
    validateAuthorsMap,
  );

  return authorsMap ? normalizeAuthorsMap(authorsMap) : undefined;
}

type AuthorsParam = {
  frontMatter: BlogPostFrontMatter;
  authorsMap: AuthorsMap | undefined;
  baseUrl: string;
};

function normalizeImageUrl({
  imageURL,
  baseUrl,
}: {
  imageURL: string | undefined;
  baseUrl: string;
}) {
  return imageURL?.startsWith('/')
    ? normalizeUrl([baseUrl, imageURL])
    : imageURL;
}

// Legacy v1/early-v2 front matter fields
// We may want to deprecate those in favor of using only frontMatter.authors
// TODO Docusaurus v4: remove this legacy front matter
function getFrontMatterAuthorLegacy({
  baseUrl,
  frontMatter,
}: {
  baseUrl: string;
  frontMatter: BlogPostFrontMatter;
}): Author | undefined {
  const name = frontMatter.author;
  const title = frontMatter.author_title ?? frontMatter.authorTitle;
  const url = frontMatter.author_url ?? frontMatter.authorURL;
  const imageURL = normalizeImageUrl({
    imageURL: frontMatter.author_image_url ?? frontMatter.authorImageURL,
    baseUrl,
  });

  if (name || title || url || imageURL) {
    return {
      name,
      title,
      url,
      imageURL,
      // legacy front matter authors do not have an author key/page
      key: null,
      page: null,
    };
  }

  return undefined;
}

function getFrontMatterAuthors(params: AuthorsParam): Author[] {
  const {authorsMap, frontMatter, baseUrl} = params;
  return normalizeFrontMatterAuthors().map(toAuthor);

  function normalizeFrontMatterAuthors(): BlogPostFrontMatterAuthor[] {
    if (frontMatter.authors === undefined) {
      return [];
    }

    function normalizeAuthor(
      authorInput: string | BlogPostFrontMatterAuthor,
    ): BlogPostFrontMatterAuthor {
      if (typeof authorInput === 'string') {
        // We could allow users to provide an author's name here, but we only
        // support keys, otherwise, a typo in a key would fall back to
        // becoming a name and may end up unnoticed
        return {key: authorInput};
      }
      return authorInput;
    }

    return Array.isArray(frontMatter.authors)
      ? frontMatter.authors.map(normalizeAuthor)
      : [normalizeAuthor(frontMatter.authors)];
  }

  function getAuthorsMapAuthor(key: string | undefined): Author | undefined {
    if (key) {
      if (!authorsMap || Object.keys(authorsMap).length === 0) {
        throw new Error(`Can't reference blog post authors by a key (such as '${key}') because no authors map file could be loaded.
Please double-check your blog plugin config (in particular 'authorsMapPath'), ensure the file exists at the configured path, is not empty, and is valid!`);
      }
      const author = authorsMap[key];
      if (!author) {
        throw Error(`Blog author with key "${key}" not found in the authors map file.
Valid author keys are:
${Object.keys(authorsMap)
  .map((validKey) => `- ${validKey}`)
  .join('\n')}`);
      }
      return author;
    }
    return undefined;
  }

  function toAuthor(frontMatterAuthor: BlogPostFrontMatterAuthor): Author {
    const author = {
      // Author def from authorsMap can be locally overridden by front matter
      ...getAuthorsMapAuthor(frontMatterAuthor.key),
      ...frontMatterAuthor,
    };

    return {
      ...author,
      key: author.key ?? null,
      page: author.page ?? null,
      imageURL: normalizeImageUrl({imageURL: author.imageURL, baseUrl}),
    };
  }
}

export function getBlogPostAuthors(params: AuthorsParam): Author[] {
  const authorLegacy = getFrontMatterAuthorLegacy(params);
  const authors = getFrontMatterAuthors(params);

  if (authorLegacy) {
    // Technically, we could allow mixing legacy/authors front matter, but do we
    // really want to?
    if (authors.length > 0) {
      throw new Error(
        `To declare blog post authors, use the 'authors' front matter in priority.
Don't mix 'authors' with other existing 'author_*' front matter. Choose one or the other, not both at the same time.`,
      );
    }
    return [authorLegacy];
  }

  return authors;
}

/**
 * Blog posts grouped by author page permalink (if page exists)
 */
export function groupBlogPostsByAuthorKey({
  blogPosts,
  authorsMap,
}: {
  blogPosts: BlogPost[];
  authorsMap: AuthorsMap | undefined;
}): Record<string, BlogPost[]> {
  return _.mapValues(authorsMap, (author, key) =>
    blogPosts.filter((p) => p.metadata.authors.some((a) => a.key === key)),
  );
}
