const router = require('express').Router();
const mongoose = require('mongoose');
const TrackData = mongoose.model('TrackData');
const Track = mongoose.model('Track');
const Comment = mongoose.model('Comment');
const User = mongoose.model('User');
const busboy = require('connect-busboy');
const auth = require('../auth');
const { normalizeUserAgent, buildObsver1 } = require('../../logic/tracks');
const wrapRoute = require('../../_helpers/wrapRoute');

function preloadByParam(target, getValueFromParam) {
  return async (req, res, next, paramValue) => {
    try {
      const value = await getValueFromParam(paramValue);

      if (!value) {
        return res.sendStatus(404);
      }

      req[target] = value;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

router.param(
  'track',
  preloadByParam('track', (slug) => Track.findOne({ slug }).populate('author')),
);
router.param(
  'comment',
  preloadByParam('comment', (id) => Comment.findById(id)),
);

router.param('comment', async (req, res, next, id) => {
  try {
    const comment = await Comment.findById(id);

    if (!comment) {
      return res.sendStatus(404);
    }

    req.comment = comment;

    return next();
  } catch (err) {
    return next(err);
  }
});

router.get(
  '/',
  auth.optional,
  wrapRoute(async (req, res) => {
    const query = { visible: true };
    let limit = 20;
    let offset = 0;

    if (typeof req.query.limit !== 'undefined') {
      limit = req.query.limit;
    }

    if (typeof req.query.offset !== 'undefined') {
      offset = req.query.offset;
    }

    if (typeof req.query.tag !== 'undefined') {
      query.tagList = { $in: [req.query.tag] };
    }

    const author = req.query.author ? await User.findOne({ username: req.query.author }) : null;

    if (author) {
      query.author = author._id;
    }

    const [tracks, tracksCount] = await Promise.all([
      Track.find(query).sort('-createdAt').limit(Number(limit)).skip(Number(offset)).sort({ createdAt: 'desc' }).populate('author').exec(),
      Track.countDocuments(query).exec(),
    ]);

    return res.json({
      tracks: tracks.map((track) => track.toJSONFor(req.user)),
      tracksCount,
    });
  }),
);

router.get(
  '/feed',
  auth.required,
  wrapRoute(async (req, res) => {
    let limit = 20;
    let offset = 0;

    if (typeof req.query.limit !== 'undefined') {
      limit = req.query.limit;
    }

    if (typeof req.query.offset !== 'undefined') {
      offset = req.query.offset;
    }

    const query = { author: req.user.id };
    const [tracks, tracksCount] = await Promise.all([
      Track.find(query).sort('-createdAt').limit(Number(limit)).skip(Number(offset)).populate('author').exec(),
      Track.countDocuments(query),
    ]);

    return res.json({
      tracks: tracks.map(function (track) {
        return track.toJSONFor(req.user);
      }),
      tracksCount: tracksCount,
    });
  }),
);

async function readFile(file) {
  let fileContent = '';

  file.on('data', function (data) {
    fileContent += data;
  });

  await new Promise((resolve, reject) => {
    file.on('end', resolve);
    file.on('error', reject);
  });

  return fileContent;
}

async function getMultipartOrJsonBody(req, mapJsonBody = (x) => x) {
  const fileInfo = {};
  let body;

  if (req.busboy) {
    body = {};

    req.busboy.on('file', async function (fieldname, file, filename, encoding, mimetype) {
      body[fieldname] = await readFile(file);
      fileInfo[fieldname] = { filename, encoding, mimetype };
    });

    req.busboy.on('field', (key, value) => {
      body[key] = value;
    });

    req.pipe(req.busboy);

    await new Promise((resolve, reject) => {
      req.busboy.on('finish', resolve);
      req.busboy.on('error', reject);
    });
  } else if (req.headers['content-type'] === 'application/json') {
    body = mapJsonBody(req.body);
  } else {
    body = { body: await readFile(req), ...req.query };
    fileInfo.body = {
      mimetype: req.headers['content-type'],
      filename: req.headers['content-disposition'],
      encoding: req.headers['content-encoding'],
    };
  }

  return { body, fileInfo };
}

router.post(
  '/',
  auth.required,
  busboy(), // parse multipart body
  wrapRoute(async (req, res) => {
    // Read the whole file into memory. This is not optimal, instead, we should
    // write the file data directly to the target file. However, we first have
    // to parse the rest of the track data to know where to place the file.
    // TODO: Stream into temporary file, then move it later.
    const { body, fileInfo } = await getMultipartOrJsonBody(req, (body) => body.track);

    const {body: fileBody, visible, ...trackBody} = body

    const track = new Track({
      ...trackBody,
      author: req.user,
      visible: visible == null ? req.user.areTracksVisibleForAll : Boolean(trackBody.visible)
    })
    track.slugify();

    if (fileBody) {
      track.uploadedByUserAgent = normalizeUserAgent(req.headers['user-agent']);
      track.originalFileName = fileInfo.body ? fileInfo.body.filename : track.slug + '.csv';
      await track.writeToOriginalFile(fileBody)
      await track.rebuildTrackDataAndSave();
    } else {
      await track.save()
    }

    // console.log(track.author);
    return res.json({ track: track.toJSONFor(req.user) });
  }),
);

// return a track
router.get(
  '/:track',
  auth.optional,
  wrapRoute(async (req, res) => {
    if (!req.track.isVisibleTo(req.user)) {
      return res.sendStatus(403);
    }

    return res.json({ track: req.track.toJSONFor(req.user) });
  }),
);

// update track
router.put(
  '/:track',
  busboy(),
  auth.required,
  wrapRoute(async (req, res) => {
    const track = req.track;

    if (!track.author._id.equals(req.user.id)) {
      return res.sendStatus(403);
    }

    const { body: {body: fileBody, ...trackBody}, fileInfo } = await getMultipartOrJsonBody(req, (body) => body.track);

    if (typeof trackBody.title !== 'undefined') {
      track.title = (trackBody.title || '').trim() || null;
    }

    if (typeof trackBody.description !== 'undefined') {
      track.description = (trackBody.description || '').trim() || null;
    }

    if (trackBody.visible != null) {
      track.visible = Boolean(trackBody.visible);
    }

    if (fileBody) {
      track.originalFileName = fileInfo.body ? fileInfo.body.filename : track.slug + '.csv';
      track.uploadedByUserAgent = normalizeUserAgent(req.headers['user-agent']);
      await track.writeToOriginalFile(fileBody)

      await track.rebuildTrackDataAndSave();
    } else if (track.visible && !track.publicTrackData) {
      await track.rebuildTrackDataAndSave();
    } else {
      await track.save();
    }

    return res.json({ track: track.toJSONFor(req.user) });
  }),
);

// delete track
router.delete(
  '/:track',
  auth.required,
  wrapRoute(async (req, res) => {
    if (req.track.author._id.equals(req.user.id)) {
      await TrackData.findByIdAndDelete(req.track.trackData);
      await req.track.remove();
      return res.sendStatus(204);
    } else {
      return res.sendStatus(403);
    }
  }),
);

// return an track's comments
router.get(
  '/:track/comments',
  auth.optional,
  wrapRoute(async (req, res) => {
    if (!req.track.isVisibleTo(req.user)) {
      return res.sendStatus(403);
    }

    await req.track
      .populate({
        path: 'comments',
        populate: {
          path: 'author',
        },
        options: {
          sort: {
            createdAt: 'asc',
          },
        },
      })
      .execPopulate();

    return res.json({
      comments: req.track.comments.map(function (comment) {
        return comment.toJSONFor(req.user);
      }),
    });
  }),
);

// create a new comment
router.post(
  '/:track/comments',
  auth.required,
  wrapRoute(async (req, res) => {
    const comment = new Comment(req.body.comment);
    comment.track = req.track;
    comment.author = req.user;

    await comment.save();

    req.track.comments.push(comment);

    await req.track.save();
    return res.json({ comment: comment.toJSONFor(req.user) });
  }),
);

router.delete(
  '/:track/comments/:comment',
  auth.required,
  wrapRoute(async (req, res) => {
    if (req.comment.author.equals(req.user.id)) {
      req.track.comments.remove(req.comment._id);
      await req.track.save();
      await Comment.find({ _id: req.comment._id }).remove();
      res.sendStatus(204);
    } else {
      res.sendStatus(403);
    }
  }),
);

// return an track's trackData
router.get(
  ['/:track/data', '/:track/TrackData'],
  auth.optional,
  wrapRoute(async (req, res) => {
    if (!req.track.isVisibleTo(req.user)) {
      return res.sendStatus(403);
    }

    let trackData;

    if (req.track.isVisibleToPrivate(req.user)) {
      trackData = await TrackData.findById(req.track.trackData);
    } else if (!req.track.publicTrackData) {
      return res.sendStatus(403);
    } else {
      trackData = await TrackData.findById(req.track.publicTrackData);
    }

    return res.json({ trackData });
  }),
);

// download the original file
router.get(
  '/:track/download',
  auth.optional,
  wrapRoute(async (req, res) => {
    if (req.track.isVisibleToPrivate(req.user)) {
      return res.download(req.track.fullOriginalFilePath)
    } else if (req.track.isVisibleTo(req.user)) {
      await req.track.populate('publicTrackData').execPopulate()

      if (!req.track.publicTrackData) {
        return res.sendStatus(403);
      }

      const body = buildObsver1(req.track.publicTrackData.points)
      const fileName = req.track.slug + '_public.csv'

      res.set({
        'Content-Disposition': 'attachment; filename=' + JSON.stringify(fileName),
        'Content-Type': 'text/csv',
      });
      return res.end(body)
    } else {
      return res.sendStatus(403);
    }
  }),
);

module.exports = router;
