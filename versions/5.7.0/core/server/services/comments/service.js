const tpl = require('@tryghost/tpl');
const errors = require('@tryghost/errors');
const {MemberCommentEvent} = require('@tryghost/member-events');
const DomainEvents = require('@tryghost/domain-events');

const messages = {
    commentNotFound: 'Comment could not be found',
    memberNotFound: 'Unable to find member',
    likeNotFound: 'Unable to find like',
    alreadyLiked: 'This comment was liked already',
    replyToReply: 'Can not reply to a reply',
    commentsNotEnabled: 'Comments are not enabled for this site.',
    cannotCommentOnPost: 'You do not have permission to comment on this post.'
};

class CommentsService {
    constructor({config, logging, models, mailer, settingsCache, urlService, urlUtils, contentGating}) {
        /** @private */
        this.models = models;

        /** @private */
        this.settingsCache = settingsCache;

        /** @private */
        this.contentGating = contentGating;

        const Emails = require('./emails');
        /** @private */
        this.emails = new Emails({
            config,
            logging,
            models,
            mailer,
            settingsCache,
            urlService,
            urlUtils
        });
    }

    /**
     * @returns {'off'|'all'|'paid'}
     */
    get enabled() {
        const setting = this.settingsCache.get('comments_enabled');
        if (setting === 'off' || setting === 'all' || setting === 'paid') {
            return setting;
        }
        return 'off';
    }

    /** @private */
    checkEnabled() {
        if (this.enabled === 'off') {
            throw new errors.MethodNotAllowedError({
                message: tpl(messages.commentsNotEnabled)
            });
        }
    }

    /** @private */
    checkCommentAccess(memberModel) {
        if (this.enabled === 'paid' && memberModel.get('status') === 'free') {
            throw new errors.NoPermissionError({
                message: tpl(messages.cannotCommentOnPost)
            });
        }
    }

    /** @private */
    checkPostAccess(postModel, memberModel) {
        const access = this.contentGating.checkPostAccess(postModel.toJSON(), memberModel.toJSON());
        if (access === this.contentGating.BLOCK_ACCESS) {
            throw new errors.NoPermissionError({
                message: tpl(messages.cannotCommentOnPost)
            });
        }
    }

    /** @private */
    async sendNewCommentNotifications(comment) {
        await this.emails.notifyPostAuthors(comment);

        if (comment.get('parent_id')) {
            await this.emails.notifyParentCommentAuthor(comment);
        }
    }

    async reportComment(commentId, reporter) {
        this.checkEnabled();
        const comment = await this.models.Comment.findOne({id: commentId}, {require: true});

        // Check if this reporter already reported this comment (then don't send an email)?
        const existing = await this.models.CommentReport.findOne({
            comment_id: comment.id,
            member_id: reporter.id
        });

        if (existing) {
            // Ignore silently for now
            return;
        }

        // Save report model
        await this.models.CommentReport.add({
            comment_id: comment.id,
            member_id: reporter.id
        });

        await this.emails.notifiyReport(comment, reporter);
    }

    /**
     * @param {any} options
     */
    async getComments(options) {
        this.checkEnabled();
        const page = await this.models.Comment.findPage(options);

        return page;
    }

    /**
     * @param {string} id - The ID of the Comment to get
     * @param {any} options
     */
    async getCommentByID(id, options) {
        this.checkEnabled();
        const model = await this.models.Comment.findOne({id}, options);

        if (!model) {
            throw new errors.NotFoundError({
                messages: tpl(messages.commentNotFound)
            });
        }

        return model;
    }

    /**
     * @param {string} post - The ID of the Post to comment on
     * @param {string} member - The ID of the Member to comment as
     * @param {string} comment - The HTML content of the Comment
     * @param {any} options
     */
    async commentOnPost(post, member, comment, options) {
        this.checkEnabled();
        const memberModel = await this.models.Member.findOne({
            id: member
        }, {
            require: true,
            ...options
        });

        this.checkCommentAccess(memberModel);

        const postModel = await this.models.Post.findOne({
            id: post
        }, {
            require: true,
            ...options
        });

        this.checkPostAccess(postModel, memberModel);

        const model = await this.models.Comment.add({
            post_id: post,
            member_id: member,
            parent_id: null,
            html: comment,
            status: 'published'
        }, options);

        if (!options.context.internal) {
            await this.sendNewCommentNotifications(model);
        }

        DomainEvents.dispatch(MemberCommentEvent.create({
            memberId: member,
            postId: post,
            commentId: model.id
        }));

        return model;
    }

    /**
     * @param {string} parent - The ID of the Comment to reply to
     * @param {string} member - The ID of the Member to comment as
     * @param {string} comment - The HTML content of the Comment
     * @param {any} options
     */
    async replyToComment(parent, member, comment, options) {
        this.checkEnabled();
        const memberModel = await this.models.Member.findOne({
            id: member
        }, {
            require: true,
            ...options
        });

        this.checkCommentAccess(memberModel);

        const parentComment = await this.getCommentByID(parent, options);
        if (!parentComment) {
            throw new errors.BadRequestError({
                message: tpl(messages.commentNotFound)
            });
        }

        if (parentComment.get('parent_id') !== null) {
            throw new errors.BadRequestError({
                message: tpl(messages.replyToReply)
            });
        }
        const postModel = await this.models.Post.findOne({
            id: parentComment.get('post_id')
        }, {
            require: true,
            ...options
        });

        this.checkPostAccess(postModel, memberModel);

        const model = await this.models.Comment.add({
            post_id: parentComment.get('post_id'),
            member_id: member,
            parent_id: parentComment.id,
            html: comment,
            status: 'published'
        }, options);

        if (!options.context.internal) {
            await this.sendNewCommentNotifications(model);
        }

        DomainEvents.dispatch(MemberCommentEvent.create({
            memberId: member,
            postId: parentComment.get('post_id'),
            commentId: model.id
        }));

        return model;
    }

    /**
     * @param {string} id - The ID of the Comment to delete
     * @param {string} member - The ID of the Member to delete as
     * @param {any} options
     */
    async deleteComment(id, member, options) {
        this.checkEnabled();
        const existingComment = await this.getCommentByID(id, options);

        if (existingComment.get('member_id') !== member) {
            throw new errors.NoPermissionError({
                // todo fix message
                message: tpl(messages.memberNotFound)
            });
        }

        const model = await this.models.Comment.edit({
            status: 'deleted'
        }, {
            id,
            require: true,
            ...options
        });

        return model;
    }

    /**
     * @param {string} id - The ID of the Comment to edit
     * @param {string} member - The ID of the Member to edit as
     * @param {string} comment - The new HTML content of the Comment
     * @param {any} options
     */
    async editCommentContent(id, member, comment, options) {
        this.checkEnabled();
        const existingComment = await this.getCommentByID(id, options);

        if (!comment) {
            return existingComment;
        }

        if (existingComment.get('member_id') !== member) {
            throw new errors.NoPermissionError({
                // todo fix message
                message: tpl(messages.memberNotFound)
            });
        }

        const model = await this.models.Comment.edit({
            html: comment,
            edited_at: new Date()
        }, {
            id,
            require: true,
            ...options
        });

        return model;
    }
}

module.exports = CommentsService;
