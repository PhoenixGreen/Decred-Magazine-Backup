const _ = require('lodash');
const url = require('../utils/url');

const commentFields = [
    'id',
    'status',
    'html',
    'created_at',
    'edited_at'
];

const memberFields = [
    'id',
    'uuid',
    'name',
    'bio',
    'avatar_image'
];

const postFields = [
    'id',
    'uuid',
    'title',
    'url'
];

const commentMapper = (model, frame) => {
    const jsonModel = model.toJSON ? model.toJSON(frame.options) : model;

    const response = _.pick(jsonModel, commentFields);

    if (jsonModel.member) {
        response.member = _.pick(jsonModel.member, memberFields);
    } else {
        response.member = null;
    }

    if (jsonModel.likes) {
        response.likes_count = jsonModel.likes.length;
    } else {
        response.likes_count = 0;
    }

    if (jsonModel.replies) {
        response.replies = jsonModel.replies.map(reply => commentMapper(reply, frame));
    }

    if (jsonModel.parent) {
        response.parent = commentMapper(jsonModel.parent, frame);
    }

    if (jsonModel.post) {
        // We could use the post mapper here, but we need less field + don't need al the async behaviour support
        url.forPost(jsonModel.post.id, jsonModel.post, frame);
        response.post = _.pick(jsonModel.post, postFields);
    }

    // todo
    response.liked = false;
    if (jsonModel.likes && frame.original.context.member && frame.original.context.member.id) {
        const id = frame.original.context.member.id;
        response.liked = !!jsonModel.likes.find(l => l.member_id === id);
    }

    return response;
};

module.exports = commentMapper;
