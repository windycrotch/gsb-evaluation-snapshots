import { createContext, useContext } from 'react'

const AppContext = createContext(null)

export const useAppContext = () => {
    const ctx = useContext(AppContext)
    if (!ctx) {
        throw new Error('useAppContext must be used inside <Provider>')
    }
    return ctx
}

export default AppContext
