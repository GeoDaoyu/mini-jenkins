export class CancelledError extends Error {
  constructor(message = '任务已取消') {
    super(message);
    this.name = 'CancelledError';
  }
}

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}
