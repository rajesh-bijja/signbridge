import { io } from 'socket.io-client'

import { getCachedUsername, getProjectName } from '../session'

let socketInstance = null

export const getSocket = () => {
  if (!socketInstance) {
    socketInstance = io()
    const userName = getCachedUsername()
    const projectName = getProjectName()
    socketInstance.emit(`event_i_am_${projectName}_user`, { userName })
  }
  return socketInstance
}

export const disconnectSocket = () => {
  if (socketInstance) {
    const userName = getCachedUsername()
    const projectName = getProjectName()
    socketInstance.emit(`event_say_bye_to_${projectName}`, { userName })
    socketInstance.disconnect()
    socketInstance = null
  }
}

export { getCachedUsername as getUserName }
