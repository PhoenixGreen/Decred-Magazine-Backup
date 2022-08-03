module.exports = function (data) {
    // Be careful when you indent the email, because whitespaces are visible in emails!
    return `Hey there,

Someone just replied to your comment on "${data.postTitle}"

${data.postUrl}#ghost-comments-root

---

Sent to ${data.toEmail} from ${data.siteDomain}.
You can manage your notification preferences at ${data.profileUrl}.`;
};
